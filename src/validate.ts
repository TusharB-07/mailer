// Server-side validation for every API input, using zod.
// These schemas are the single source of truth — the browser also
// validates for UX, but the Worker never trusts the client.
import { z } from "zod";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/, "invalid email");

// Extra Excel columns become merge data. Coerce anything to string.
const mergeValue = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .transform((v) => (v === null ? "" : String(v)));

// A single recipient row. Email is required; subject/body optional
// (the campaign-level template is the default; a row can override).
const reservedKeys = ["email", "subject", "body", "sendat", "send_at"];
export const RowSchema = z
  .object({
    email: email,
    subject: z.string().max(998).optional(),
    body: z.string().max(200_000).optional(),
    sendAt: z.string().optional(),
  })
  .catchall(mergeValue)
  .strict(); // unknown top-level keys are folded into catchall as merge data

export const RowArraySchema = z.array(RowSchema).min(1, "at least one row").max(10_000, "max 10,000 rows");

export const CampaignCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    senderAddress: email,
    senderMailboxId: z.string().max(64).optional(),
    replyTo: email.optional(),
    // Templates are OPTIONAL when every row carries its own Subject/Body.
    // Refined below: either a campaign template OR a per-row value must exist
    // for every row.
    subjectTemplate: z.string().max(998).optional(),
    bodyTemplate: z.string().max(200_000).optional(),
    rows: RowArraySchema,
    scheduleMode: z.enum(["now", "datetime", "interval"]),
    scheduledAt: z.string().optional(), // ISO 8601 string; required when mode=datetime
    intervalMinutes: z.number().int().min(1).max(1440).default(30),
    batchSize: z.number().int().min(1).max(100).default(5),
    trackingEnabled: z.boolean().default(true),
    recurring: z
      .object({
        freq: z.enum(["daily", "weekly", "monthly"]),
        until: z.string().optional(), // ISO 8601 or null = forever
      })
      .optional(),
    attachmentIds: z.array(z.string().max(64)).max(10).default([]),
  })
  .superRefine((val, ctx) => {
    // Subject: campaign template OR every row must carry its own.
    const hasSubjectTpl = !!val.subjectTemplate?.trim();
    if (!hasSubjectTpl && val.rows.some((r) => !r.subject?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjectTemplate"],
        message:
          "provide a campaign subject template, or give every row its own Subject column",
      });
    }
    // Body: campaign template OR every row must carry its own.
    const hasBodyTpl = !!val.bodyTemplate?.trim();
    if (!hasBodyTpl && val.rows.some((r) => !r.body?.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bodyTemplate"],
        message:
          "provide a campaign body template, or give every row its own Body column",
      });
    }
    if (val.scheduleMode === "datetime" && !val.scheduledAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledAt"],
        message: "required when scheduleMode is 'datetime'",
      });
    }
    if (val.scheduledAt) {
      const t = Date.parse(val.scheduledAt);
      if (Number.isNaN(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scheduledAt"],
          message: "must be a valid ISO 8601 datetime",
        });
      }
    }
    if (val.recurring?.until) {
      const t = Date.parse(val.recurring.until);
      if (Number.isNaN(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recurring.until"],
          message: "must be a valid ISO 8601 datetime",
        });
      }
    }
  });

export const TestSendSchema = z.object({
  testEmail: email,
});

export const AttachmentIdSchema = z.object({
  id: z.string().max(64),
});

export const LoginSchema = z.object({
  password: z.string().min(1).max(1000),
});

export const CampaignIdSchema = z.object({ id: z.string().max(64) });

export type CampaignCreateInput = z.infer<typeof CampaignCreateSchema>;
export type RowInput = z.infer<typeof RowSchema>;
