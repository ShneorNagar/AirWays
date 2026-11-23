import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// API error codes and their Hebrew messages. Format: { error, message }.
export const ERROR_MESSAGES = {
  unauthorized: "יש להתחבר כדי לבצע פעולה זו.",
  banned: "החשבון שלך הושעה.",
  forbidden: "אין לך הרשאה לבצע פעולה זו.",
  not_found: "הפריט המבוקש לא נמצא.",
  bad_request: "הבקשה אינה תקינה.",
  csrf: "הבקשה נחסמה מסיבות אבטחה.",
  validation: "הטקסט שהוזן אינו תקין.",
  rate_limited: "הגעת למגבלת השימוש היומית. נסה שוב מאוחר יותר.",
  insufficient_credits: "אין לך מספיק קרדיטים.",
  no_season: "אין עונה פעילה כרגע. נסה שוב בעוד כמה דקות.",
  conflict: "כבר הגשת ערעור על תור זה.",
  not_appealable: "לא ניתן לערער על תור זה.",
  oauth_failed: "ההתחברות עם Google נכשלה.",
  internal: "אירעה שגיאה. נסה שוב.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  error: ErrorCode,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error, message: ERROR_MESSAGES[error], ...extra }, status);
}
