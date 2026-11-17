import { z } from "zod"

export const issueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)

export const issueUpdateFields = {
  status: z.enum(["resolved", "unresolved"]).optional(),
  assignedTo: z
    .string()
    .regex(/^(user:\d+|team:[A-Za-z0-9_-]+)$/)
    .nullable()
    .optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
}

export const issueUpdateSchema = z
  .object(issueUpdateFields)
  .strict()
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Provide status, assignedTo or priority",
  )

export type IssueUpdate = z.infer<typeof issueUpdateSchema>
