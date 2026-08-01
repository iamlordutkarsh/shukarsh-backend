import { Prisma } from "@prisma/client";
import { z } from "zod";
import { effectiveAttributes } from "./category";

type Db = Prisma.TransactionClient;

/**
 * One answer, as it arrives from a browser.
 *
 * Keyed by the definition's `key` rather than its id, because the admin form is
 * built from `effectiveAttributes` and a key is the stable name there: an
 * inherited question keeps its key wherever it is answered, while its id belongs
 * to whichever ancestor happens to define it.
 */
export const attributeAnswerSchema = z.object({
  key: z.string().trim().min(1).max(40),
  /** For SELECT: one option value. For MULTISELECT: several. */
  values: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  /** For TEXT. */
  text: z.string().trim().max(200).optional().nullable(),
  /** For NUMBER. */
  number: z.number().finite().optional().nullable(),
});

export type AttributeAnswer = z.infer<typeof attributeAnswerSchema>;

/** Refused with a message an admin can act on, rather than a field path. */
export class AttributeError extends Error {}

/**
 * What a product already answered, in the shape a save takes.
 *
 * Lets a category change be re-checked without the caller having to resend the
 * answers: the same rows go back through saveProductAttributes against the new
 * category, so a required question the product cannot satisfy is refused rather
 * than silently left blank.
 */
export async function currentAnswers(tx: Db, productId: string): Promise<AttributeAnswer[]> {
  const rows = await tx.productAttribute.findMany({
    where: { productId },
    include: { definition: { select: { key: true, kind: true } }, option: { select: { value: true } } },
  });

  const byKey = new Map<string, AttributeAnswer>();

  for (const row of rows) {
    const key = row.definition.key;
    const answer = byKey.get(key) ?? { key, values: [], text: null, number: null };

    if (row.option) answer.values.push(row.option.value);
    if (row.valueText != null) answer.text = row.valueText;
    if (row.valueNumber != null) answer.number = Number(row.valueNumber);

    byKey.set(key, answer);
  }

  return [...byKey.values()];
}

/**
 * Replaces a product's answers, having checked them against its category.
 *
 * Everything is validated before anything is written, and the whole thing runs
 * inside the caller's transaction, so a product never ends up half answered: a
 * form that fails on the eleventh question must not have already saved ten.
 *
 * Answers to questions the category does not ask are dropped rather than
 * refused. Moving a product from Tshirts to Mugs leaves its old sleeve length
 * behind, and that is a re-filing, not a mistake worth blocking the save over.
 */
export async function saveProductAttributes(
  tx: Db,
  productId: string,
  categoryId: string,
  answers: AttributeAnswer[]
): Promise<void> {
  const definitions = await effectiveAttributes(categoryId);
  // Driven by the definitions, not by what arrived, which is what drops an answer
  // to a question this category does not ask.
  const given = new Map(answers.map((answer) => [answer.key, answer]));

  const rows: Prisma.ProductAttributeCreateManyInput[] = [];

  for (const definition of definitions) {
    const answer = given.get(definition.key);

    const picks = definition.kind === "SELECT" || definition.kind === "MULTISELECT";
    const chosen = answer?.values ?? [];
    const text = answer?.text?.trim() || null;
    const number = answer?.number ?? null;

    const empty = picks ? chosen.length === 0 : definition.kind === "TEXT" ? !text : number == null;

    if (empty) {
      if (definition.required) {
        throw new AttributeError(`${definition.label} is needed for this category.`);
      }
      continue;
    }

    if (picks) {
      if (definition.kind === "SELECT" && chosen.length > 1) {
        throw new AttributeError(`${definition.label} takes one answer, not ${chosen.length}.`);
      }

      const optionByValue = new Map(definition.options.map((option) => [option.value, option.id]));

      for (const value of new Set(chosen)) {
        const optionId = optionByValue.get(value);
        // A value that is not on the list is the whole failure this table exists
        // to prevent: accepting it would put "100% cotton" beside "Cotton" and
        // quietly break every filter built on the question.
        if (!optionId) {
          throw new AttributeError(`"${value}" is not one of the choices for ${definition.label}.`);
        }
        rows.push({ productId, definitionId: definition.id, optionId });
      }
      continue;
    }

    rows.push({
      productId,
      definitionId: definition.id,
      ...(definition.kind === "TEXT" ? { valueText: text } : { valueNumber: number }),
    });
  }

  // Replaced wholesale rather than diffed. An answer carries nothing of its own
  // worth preserving — no history, no ledger — so the simplest correct thing is
  // to clear and rewrite, which also cannot leave a stale row behind when a
  // question stops applying.
  await tx.productAttribute.deleteMany({ where: { productId } });
  if (rows.length > 0) await tx.productAttribute.createMany({ data: rows });
}

export interface SerializedProductAttribute {
  key: string;
  label: string;
  kind: string;
  unit: string | null;
  /** Always a list, so one shape reads for SELECT and MULTISELECT alike. */
  values: string[];
}

/**
 * A product's answers, in the order its category asks them.
 *
 * Grouped by definition so a MULTISELECT reads as one row with several values
 * rather than several rows, which is how a spec table has to draw it.
 */
export function serializeProductAttributes(rows: any[]): SerializedProductAttribute[] {
  const grouped = new Map<string, SerializedProductAttribute & { position: number }>();

  for (const row of rows) {
    const definition = row.definition;
    if (!definition) continue;

    const existing = grouped.get(definition.key) ?? {
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      unit: definition.unit ?? null,
      values: [] as string[],
      position: definition.position ?? 0,
    };

    const value =
      row.option?.value ??
      row.valueText ??
      (row.valueNumber != null ? String(Number(row.valueNumber)) : null);

    if (value != null) existing.values.push(value);
    grouped.set(definition.key, existing);
  }

  return [...grouped.values()]
    .filter((attribute) => attribute.values.length > 0)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map(({ position: _position, ...attribute }) => attribute);
}
