// The style vocabulary, shared by every axis.
//
// These are semantic names, not colours: a theme decides what "keyword" looks like. That
// separation is what lets the same renderer serve a dark terminal, a light one, and a
// future theme file without touching a single call site.
export type Style =
  | "user"
  | "weaver"
  | "heading"
  | "code"
  | "tool"
  | "ok"
  | "fail"
  | "warn"
  | "error"
  | "notice"
  | "canary"
  | "dim"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "accent"
  | "bold";
