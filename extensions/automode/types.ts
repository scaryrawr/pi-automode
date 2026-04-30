import z from "zod";

export const modelIdentifierSchema = z.object({
  provider: z.string(),
  id: z.string(),
});

export type ModelIdentifier = z.infer<typeof modelIdentifierSchema>;
