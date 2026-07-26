import { z } from "zod";

export const INDIAN_STATES = [
  "Andaman & Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra & Nagar Haveli & Daman & Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu & Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

const stateLookup = new Map(INDIAN_STATES.map((state) => [state.toLowerCase(), state]));

export function canonicalState(value: string): string | null {
  return stateLookup.get(value.trim().toLowerCase()) ?? null;
}

export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[^0-9]/g, "").replace(/^0+/, "").replace(/^91(?=\d{10}$)/, ""))
  .refine((value) => /^[6-9]\d{9}$/.test(value), "Enter a valid 10 digit Indian mobile number");

export const pincodeSchema = z.string().regex(/^[1-9]\d{5}$/, "Enter a valid 6 digit pincode");

export const shippingAddressSchema = z.object({
  name: z.string().trim().min(3, "Full name is required").max(80),
  phone: phoneSchema,
  line1: z.string().trim().min(5, "Address is required").max(80),
  line2: z.string().trim().max(80).optional(),
  city: z.string().trim().min(2).max(30),
  state: z.string().trim().min(2).transform((value, ctx) => {
    const canonical = canonicalState(value);
    if (!canonical) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a valid Indian state" });
      return z.NEVER;
    }
    return canonical;
  }),
  zip: pincodeSchema,
  country: z.string().trim().default("India"),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}
