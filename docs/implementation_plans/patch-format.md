# Goat Patch Format

## Overview

`apply_patch` accepts one structured patch format in V1.

Malformed patches are validation failures. Goat must not partially apply a malformed patch on a best-effort basis.

## Structure

A patch is a sequence of one or more file hunks wrapped in:

```text
*** Begin Patch
...
*** End Patch
```

Supported hunk headers:

- `*** Add File: <path>`
- `*** Delete File: <path>`
- `*** Update File: <path>`
- `*** Move to: <path>`

## Line prefixes

Inside an update hunk:

- context lines begin with a single space
- removed lines begin with `-`
- added lines begin with `+`
- hunk context markers begin with `@@`

Inside an add-file hunk:

- every file-content line begins with `+`

## Grammar

```text
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

`filename` is any non-empty path string accepted by Goat's normal path-resolution rules.

## Semantics

- `Add File` creates a new file and fails if the target already exists
- `Delete File` removes an existing file and fails if the target is missing
- `Update File` applies exact context-sensitive edits to an existing file
- `Move to` renames the current update-file target after a successful patch application
- `*** End of File` is used when the patch needs to match or write the logical end of the file explicitly

## Failure behavior

Goat must fail the patch if:

- block markers are malformed
- a referenced file path is invalid
- update context does not match exactly
- an add-file target already exists
- a delete-file or update-file target is missing
- the patch mixes unsupported constructs

Malformed or mismatched patches should surface as tool validation or patch-context errors, not silent partial edits.
