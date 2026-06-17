---
name: Dashboard location labels (address vs ID)
description: Where to get human-readable property/unit labels for drilldowns, per data source.
---

# Human-readable location labels in drilldowns

Drilldowns should show addresses/units, never raw upstream numeric IDs.

**Why:** the client reads these tables; Buildium/RentEngine internal IDs are meaningless to them.

**How to apply (per data source):**
- **Buildium-backed** rows: join to the local `properties`/`units` tables and use
  `propName(property_id)` (maps property_id→name) + `unit_number`. Fall back to `"—"`, not the id.
- **RentEngine-backed** rows (the `reUnits` / `reAvailable` arrays): each unit carries an
  `address` object whose `formatted_address` (e.g. `"2642 E Ocean View Ave #B4"`) already
  includes the unit. Use the `reAddr(u)` helper = `u?.address?.formatted_address || #${id}`.
  RentEngine units have **no** separate `unit_number` field — the address is the identifier.
- Column header for RentEngine address columns is `"Address"`; Buildium uses split
  `"Property"` + `"Unit"` columns.

The frontend `DrillTable` is schema-agnostic (renders whatever `cols`/`rows` it's given) and
drilldowns are keyed by name, so changing column headers/row shapes is safe — no frontend change needed.
