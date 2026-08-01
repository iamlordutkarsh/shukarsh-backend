import { prisma } from "./prisma";
import { createTtlCache } from "./parcel";

export interface SerializedCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  position: number;
  parentId: string | null;
  /** Root first, this category last. What a breadcrumb reads straight off. */
  path?: SerializedCrumb[];
  children?: SerializedCategory[];
}

export interface SerializedCrumb {
  id: string;
  name: string;
  slug: string;
}

export interface SerializedAttribute {
  id: string;
  key: string;
  label: string;
  kind: "SELECT" | "MULTISELECT" | "TEXT" | "NUMBER";
  unit: string | null;
  required: boolean;
  filterable: boolean;
  position: number;
  options: { id: string; value: string; position: number }[];
  /**
   * Which category in the chain actually defines this. Shown in the admin so it
   * is obvious that editing "Country of origin" under Tshirts is really editing
   * the root's question, and will change every other category under it too.
   */
  categoryId: string;
  categoryName?: string;
  /** True when it came from an ancestor rather than the category itself. */
  inherited: boolean;
}

export function serializeCategory(category: any): SerializedCategory {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description ?? null,
    image: category.image ?? null,
    position: category.position ?? 0,
    parentId: category.parentId ?? null,
  };
}

/**
 * The whole tree, in one query.
 *
 * Built in memory from a flat read rather than with nested `include`s, because
 * `include: { children: { include: { children: ... } } }` has to name a depth,
 * and the depth is exactly the thing a shop changes when it adds a level.
 * A catalogue's categories number in the hundreds at worst, so one read and a
 * map is cheaper than the round trips a recursive query would cost.
 */
export function buildTree(categories: any[]): SerializedCategory[] {
  const nodes = new Map<string, SerializedCategory & { children: SerializedCategory[] }>();
  for (const category of categories) {
    nodes.set(category.id, { ...serializeCategory(category), children: [] });
  }

  const roots: SerializedCategory[] = [];
  for (const category of categories) {
    const node = nodes.get(category.id)!;
    // A child whose parent was deleted, or points outside this read, is treated
    // as a root rather than dropped: an orphan the admin can see is fixable, one
    // that silently vanishes from the tree is not.
    const parent = category.parentId ? nodes.get(category.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: SerializedCategory[]) => {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const node of list) if (node.children) sort(node.children);
  };
  sort(roots);

  return roots;
}

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

/**
 * Every category, cached for a minute.
 *
 * The tree is read on nearly every catalogue request — to find a page's
 * ancestors, and to find everything filed below it — and it changes about as
 * often as the shop is rearranged. Reading it per request cost one query per
 * level per call, and the pooler in front of this database allows fifteen
 * clients in total: a handful of visitors was enough to exhaust it and take the
 * process down with `max clients reached`.
 *
 * A whole catalogue's categories are a few hundred rows at worst, so one read
 * and a walk in memory is both cheaper and far kinder to the pool than any
 * number of clever queries.
 */
const categoryCache = createTtlCache<CategoryRow[]>(60);

async function allCategories(): Promise<CategoryRow[]> {
  const cached = categoryCache.get("all");
  if (cached) return cached;

  const rows = await prisma.category.findMany({
    select: { id: true, name: true, slug: true, parentId: true },
  });

  categoryCache.set("all", rows);
  return rows;
}

/**
 * Drops the cached tree.
 *
 * Called by whatever writes a category, so an admin who adds one sees it on the
 * next screen rather than up to a minute later. Wrong-looking staleness in the
 * admin is worse than the read it saves.
 */
export function forgetCategories(): void {
  categoryCache.forget("all");
}

/**
 * A category and every ancestor above it, root first.
 *
 * Walked in memory off one cached read. The loop is still bounded, because a
 * parent chain that somehow points at itself must stop rather than hang the
 * request — the API refuses to create one, but a database restored from
 * elsewhere owes us nothing.
 */
export async function ancestorsOf(categoryId: string): Promise<CategoryRow[]> {
  const byId = new Map((await allCategories()).map((category) => [category.id, category]));

  const chain: CategoryRow[] = [];
  const seen = new Set<string>();
  let currentId: string | null = categoryId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const category = byId.get(currentId);
    if (!category) break;
    chain.unshift(category);
    currentId = category.parentId;
  }

  return chain;
}

/**
 * Every question a product in this category has to answer.
 *
 * Collected from the root downwards, so a key defined again lower down replaces
 * the one above it: a branch can narrow a general question without the root
 * having to know it happened. Order is the chain's, then each definition's own
 * position, which puts the general questions above the specific ones — the same
 * order somebody would ask them out loud.
 */
export async function effectiveAttributes(categoryId: string): Promise<SerializedAttribute[]> {
  const chain = await ancestorsOf(categoryId);
  if (chain.length === 0) return [];

  const definitions = await prisma.attributeDefinition.findMany({
    where: { categoryId: { in: chain.map((category) => category.id) } },
    include: { options: { orderBy: [{ position: "asc" }, { value: "asc" }] } },
    orderBy: { position: "asc" },
  });

  const nameById = new Map(chain.map((category) => [category.id, category.name]));
  const byKey = new Map<string, SerializedAttribute>();

  // Root first, so a deeper definition of the same key overwrites the shallower.
  for (const category of chain) {
    for (const definition of definitions.filter((row) => row.categoryId === category.id)) {
      byKey.set(definition.key, {
        id: definition.id,
        key: definition.key,
        label: definition.label,
        kind: definition.kind,
        unit: definition.unit,
        required: definition.required,
        filterable: definition.filterable,
        position: definition.position,
        options: definition.options.map((option) => ({
          id: option.id,
          value: option.value,
          position: option.position,
        })),
        categoryId: definition.categoryId,
        categoryName: nameById.get(definition.categoryId),
        inherited: definition.categoryId !== categoryId,
      });
    }
  }

  const depth = new Map(chain.map((category, index) => [category.id, index]));

  return [...byKey.values()].sort(
    (a, b) =>
      (depth.get(a.categoryId) ?? 0) - (depth.get(b.categoryId) ?? 0) ||
      a.position - b.position ||
      a.label.localeCompare(b.label)
  );
}

/** Every category at or below this one, for a listing that includes subcategories. */
export async function descendantIds(categoryId: string): Promise<string[]> {
  const all = await allCategories();

  const childrenOf = new Map<string, string[]>();
  for (const category of all) {
    if (!category.parentId) continue;
    const siblings = childrenOf.get(category.parentId) ?? [];
    siblings.push(category.id);
    childrenOf.set(category.parentId, siblings);
  }

  const collected: string[] = [];
  const queue = [categoryId];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    collected.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }

  return collected;
}
