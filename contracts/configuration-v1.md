# Same-instance configuration contract v1

Configuration writes execute on the `ConfigTab` belonging to the displayed
Driver/Lua BUILD instance. A transaction contains 1–64 checked option writes.
Keys are bounded identifiers and must already exist in native `varControls`;
values are finite booleans, numbers, or strings of at most 4096 characters.

The browser bridge exports an exact build-code snapshot before each operation,
tracks automatic versus manual ownership, and prevents automatic writes from
overwriting a manually owned option. The native bridge snapshots the active
config input table, applies all writes, invokes normal ConfigTab undo, control,
mod-list, build-dirty, and calculation hooks, and rolls back the whole table on
failure. Browser undo restores the exact prior build into the same instance.
Transactions are serialized, snapshots are limited to 8 MiB, and history is
bounded to 20 entries.

This contract is a safe primitive, not an automatic-configuration inference
engine. Eligibility reports, guide preset resolution, sparse multi-pass policy,
inactive-set handling, and reviewed per-option assumptions remain future work.
