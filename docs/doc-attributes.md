# Doc attributes v1

A doc attribute is a line in a `.did` doc comment that tools read as data:

```candid
type Tokens = record {
  /// @amount(decimals = 8, symbol = "ICP")
  e8s : nat64;
};
service : {
  decimals : () -> (nat8) query;
  /// Send tokens to another principal.
  /// @intent(title = "Send", template = "Send {amount} to {to}")
  /// @amount(at = "amount", decimals = query(decimals))
  send : (record { to : principal; amount : nat }) -> (variant { Ok : nat; Err : text });
}
```

This document is the syntax and the data model. It gives no attribute a meaning: which names exist and what their
arguments say belongs to the tool that reads them (Candid Profile, for example, reads `@amount`, `@intent` and the rest
of its tags). candid-core parses every attribute the same way, refuses a malformed one, and hands each out with the
place it was written. `DocAttributes::from_source_info` is the Rust entry point and `didToDocAttributes` the
`@candid-core/cli` one.

Attributes live in the [`SourceInfo`](contract-graph.md) sidecar, never in the Contract: adding, changing or removing
one changes `source_bundle_id` (the source text changed) and never `contract_id` or `interface_id`.

## Doc lines

Doc lines are the `docs` that `SourceInfo` records for an item: the `//` and `///` line comments on their own lines
directly above it, with no blank line between them and the item. A comment that follows code on the same line, a block
comment, and a comment separated from the item by a blank line are not doc lines (that is how the pinned
`candid_parser` attaches comments).

Items that carry docs: the actor (`service : …`), a declaration (`type T = …`), a field or variant case
(`field_labels`), and a service method. Function parameters carry none, so a tool that needs to describe a parameter
puts the attribute on the method and names the parameter in an argument.

Each recorded doc string is normalized before it is read: one leading `/` is removed if present (what is left of a
`///` comment after the upstream lexer strips `//`), then leading and trailing whitespace. `/// text`, `// text` and
`////text` all read as `text`.

## Attribute lines

A normalized doc line is an **attribute line** when it starts with `@`, then a name, then either `(` with no space
before it or the end of the line. Every other line is **prose**, kept in order:

| Doc line | Reads as |
| --- | --- |
| `@deprecated` | attribute `deprecated`, no arguments |
| `@amount(decimals = 8)` | attribute `amount` |
| `@ui.hidden()` | attribute `ui.hidden`, no arguments |
| `@param amount the value` | prose (text follows the name) |
| `@amount (decimals = 8)` | prose (a space before `(`) |
| `see @amount(decimals = 8)` | prose (does not start with `@`) |
| `@Amount(decimals = 8)` | prose (a name starts with a lowercase letter) |

An attribute line must then parse to its end; anything else is an error, not prose. An argument list whose brackets
are still open at the end of a line continues on the next doc line of the same item, so a long attribute can span
lines. A string cannot.

```text
attribute = "@" name [ "(" [ argument { "," argument } [ "," ] ] ")" ]
name      = segment { "." segment }
segment   = lower { lower | digit | "_" }
argument  = key "=" value
key       = ident | text
value     = text | number | "true" | "false" | call | ident | list | record
call      = ident "(" [ value { "," value } [ "," ] ] ")"
list      = "[" [ value { "," value } [ "," ] ] "]"
record    = "{" [ argument { "," argument } [ "," ] ] "}"
ident     = ( letter | "_" ) { letter | digit | "_" }      (not "true" or "false")
number    = [ "-" ] ( "0" | nonzero { digit } ) [ "." digit { digit } ]
text      = '"' { char | escape } '"'
escape    = "\\" | '\"' | "\n" | "\r" | "\t" | "\u{" hex { hex } "}"   (1 to 6 hex digits, a Unicode scalar value)
```

Spaces and tabs may appear between any two tokens, and the line breaks between continued lines count as spaces.

- **Keys are unique** within one argument list and within one record, compared after decoding, so `x` and `"x"` are
  the same key. A repeated key is `doc_attribute_duplicate_key`. A key that is not an identifier, such as a variant
  path, is written as text: `{ Ok = "success", "Err.TooOld" = "fail" }`.
- **Names may repeat** on one item: `@amount(at = "a")` and `@amount(at = "b")` are two attributes, in order.
- **Numbers keep their spelling.** `8`, `-1` and `0.25` are carried as the text written, never as a binary float, so
  no reader loses precision. Leading zeros (`08`), a bare `.5`, exponents and `+` are malformed.
- **Nesting is bounded** by `Limits::max_source_nesting`: the attribute's own parentheses and every `(`, `[` and `{`
  inside it count one level each. Past the limit the result is `resource_limit_exceeded` with resource
  `source_nesting`.

## Data model

```ts
type DocAttributes = {
  doc_attributes_version: 1;
  items: DocItem[];            // every item with at least one doc line
};
type DocItem = {
  kind: "actor" | "declaration" | "field" | "method";
  origin: SourceOrigin;        // as in SourceInfo
  path: string;                // "actor", "type:<Name>", or the SourceInfo occurrence path
  name?: string;               // declaration name, method name, or the field's named label
  prose: string[];             // the prose lines, normalized, in order
  attributes: DocAttribute[];  // in order
};
type DocAttribute = { name: string; doc_line: number; args: DocArgument[] };   // doc_line: index into the item's docs
type DocArgument = { key: string; value: DocValue };
type DocValue =
  | { kind: "text"; value: string }      // escapes decoded
  | { kind: "number"; value: string }    // as written
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; value: string }
  | { kind: "call"; name: string; args: DocValue[] }
  | { kind: "list"; items: DocValue[] }
  | { kind: "record"; fields: DocArgument[] };
```

Items come in this order: the actor, then declarations, methods and fields, each in `SourceInfo` order. A method or
field item's `path` is the occurrence path `SourceInfo` records for it (for example `actor.methods[2]`,
`type:Tokens.fields[0]` or `actor.methods[1].function.args[0].type.fields[0]`), so a reader that needs the Contract
coordinates of a field finds them on the `field_labels` entry with the same `origin` and `path`.

## Errors

Parsing fails closed. Every attribute line that does not parse adds one error, and the call returns the errors instead
of a partial result:

| Code | When |
| --- | --- |
| `doc_attribute_malformed` | An attribute line does not match the grammar: a missing `=`, an unclosed string or bracket, an unknown escape, text after the closing `)`, a malformed number |
| `doc_attribute_duplicate_key` | A key repeats in one argument list or record |
| `resource_limit_exceeded` | Nesting passed `max_source_nesting` (resource `source_nesting`), or the errors passed `max_diagnostics` (resource `diagnostics`; the last error is replaced by this one) |

Each error has phase `parse`, `path` set to the item's path, a span naming the item's source (no byte offsets:
`SourceInfo` keeps none), and a message naming the doc line, counted from 1.

## Versioning

`doc_attributes_version` is 1. A change that reads an existing line differently, or changes the data model's existing
fields, is a new version. Adding a value kind is too, because a reader may switch on `kind` exhaustively.
