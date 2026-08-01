import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * How many filters may be offered at once.
 *
 * Each one costs a query, and the pooler allows fifteen clients across the whole
 * service, so this is a budget rather than a preference.
 */
const MAX_FACETS = 8;

/** What was picked, keyed by the question's key: `{ fabric: ["Cotton"] }`. */
export type SelectedFacets = Record<string, string[]>;

export interface FacetValue {
  value: string;
  /** How many products would be left if this were picked too. */
  count: number;
  selected: boolean;
}

export interface Facet {
  key: string;
  label: string;
  values: FacetValue[];
}

/**
 * Reads the picked facets out of a query string.
 *
 * Bracket syntax, `?a[fabric]=Cotton,Blend`, because Express parses it into an
 * object for free and it survives being pasted into a chat window. Several values
 * for one question are comma separated: that reads as "cotton or blend", which is
 * what a shopper ticking two boxes means.
 *
 * Anything malformed is dropped rather than refused. A filter is not worth a 400,
 * and a link somebody edited by hand should degrade to a wider result, not an
 * error page.
 */
export function readFacets(raw: unknown): SelectedFacets {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const selected: SelectedFacets = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!/^[a-z0-9-]+$/.test(key)) continue;

    const values = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (values.length > 0) selected[key] = values;
  }

  return selected;
}

/**
 * One condition per picked question.
 *
 * And between questions, or within one: "cotton or blend, and half sleeve" is
 * what ticking those three boxes means. Anding within a question instead would
 * ask for a shirt that is both cotton and blend, which is nothing.
 */
export function facetWhere(selected: SelectedFacets, except?: string): Prisma.ProductWhereInput[] {
  return Object.entries(selected)
    .filter(([key]) => key !== except)
    .map(([key, values]) => ({
      attributes: {
        some: { definition: { key }, option: { value: { in: values } } },
      },
    }));
}

/**
 * The filters worth offering, and how many products each would leave.
 *
 * Only questions the products in front of us actually answer, so a shop browsing
 * kitchenware is not offered a sleeve length. Nothing has to say which questions
 * belong to which branch: the answers already know.
 *
 * Each facet is counted with **its own** filter lifted, which is what keeps the
 * other cottons visible after you tick blend. Counting everything against the
 * full filter set would show a zero beside every option in a question the shopper
 * has already narrowed, and the only way back would be to untick.
 */
export async function facetsFor(params: {
  base: Prisma.ProductWhereInput;
  selected: SelectedFacets;
}): Promise<Facet[]> {
  const { base, selected } = params;

  // Which questions the matching products answer at all. Capped hard, because
  // each one below costs a query, and the pooler in front of this database
  // allows fifteen clients in total. A filter panel with eight rows in it is
  // already more than anybody reads.
  const answered = await prisma.productAttribute.findMany({
    where: {
      product: { AND: [base, ...facetWhere(selected)] },
      definition: { filterable: true },
      optionId: { not: null },
    },
    select: { definitionId: true },
    distinct: ["definitionId"],
    take: MAX_FACETS,
  });

  if (answered.length === 0) return [];

  const definitions = await prisma.attributeDefinition.findMany({
    where: { id: { in: answered.map((row) => row.definitionId) } },
    include: { options: { orderBy: [{ position: "asc" }, { value: "asc" }] } },
    orderBy: { position: "asc" },
  });

  /**
   * One grouped count per facet, run **one at a time**.
   *
   * This was a Promise.all, which asked the database for every facet at once and
   * took a connection for each. Behind a pooler that allows fifteen clients in
   * total, a single visitor opening a filtered category could exhaust it, and the
   * error that came back was fatal enough to restart the process.
   *
   * Sequential is slower by the round trip, and that is the right trade: a filter
   * panel that takes an extra moment beats a shop that falls over.
   */
  const facets: Facet[] = [];

  for (const definition of definitions) {
    const counts = await prisma.productAttribute.groupBy({
      by: ["optionId"],
      where: {
        definitionId: definition.id,
        product: { AND: [base, ...facetWhere(selected, definition.key)] },
      },
      _count: { productId: true },
    });

    const countByOption = new Map(counts.map((row) => [row.optionId, row._count.productId]));
    const picked = selected[definition.key] ?? [];

    const values = definition.options
      .map((option) => ({
        value: option.value,
        count: countByOption.get(option.id) ?? 0,
        selected: picked.includes(option.value),
      }))
      // An option nothing has is noise, unless it is already ticked: hiding that
      // would strand a shopper on a filter they cannot see to remove.
      .filter((value) => value.count > 0 || value.selected);

    if (values.length > 0) facets.push({ key: definition.key, label: definition.label, values });
  }

  return facets;
}
