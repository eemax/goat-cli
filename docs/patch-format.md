# Patch Format

## Overview

`apply_patch` accepts one structured patch format. Malformed patches are validation failures -- Goat never partially applies a malformed patch.

## Structure

A patch is a sequence of one or more file hunks:

```
*** Begin Patch
...
*** End Patch
```

## Hunk types

| Header | Description |
|--------|-------------|
| `*** Add File: <path>` | Create a new file (fails if target exists) |
| `*** Delete File: <path>` | Remove a file (fails if target is missing) |
| `*** Update File: <path>` | Apply context-sensitive edits to an existing file |
| `*** Move to: <path>` | Rename the file after a successful update |

## Line prefixes

Inside an **update hunk**:

| Prefix | Meaning |
|--------|---------|
| ` ` (space) | Context line |
| `-` | Removed line |
| `+` | Added line |
| `@@` | Hunk context marker |

Inside an **add-file hunk**: every content line begins with `+`.

## Grammar

```
patch         := begin_patch hunk+ end_patch
begin_patch   := "*** Begin Patch" LF
end_patch     := "*** End Patch" LF?

hunk          := add_hunk | delete_hunk | update_hunk
add_hunk      := "*** Add File: " filename LF add_line+
delete_hunk   := "*** Delete File: " filename LF
update_hunk   := "*** Update File: " filename LF move_header? change_block?
move_header   := "*** Move to: " filename LF

change_block  := (change_context | change_line)+ eof_line?
change_context:= ("@@" | "@@ " text) LF
change_line   := ("+" | "-" | " ") text LF
add_line      := "+" text LF
eof_line      := "*** End of File" LF
```

`filename` is any non-empty path accepted by Goat's path-resolution rules.

## Example

```
*** Begin Patch
*** Update File: src/config.ts
@@ load function
 function load(path: string) {
-  return readFileSync(path, "ascii");
+  return readFileSync(path, "utf8");
 }
*** Add File: src/new-module.ts
+export function hello() {
+  return "world";
+}
*** End Patch
```

## Failure conditions

The patch fails if:

- Block markers are malformed
- A referenced file path is invalid
- Update context does not match exactly
- An add-file target already exists
- A delete-file or update-file target is missing
- The patch contains unsupported constructs
