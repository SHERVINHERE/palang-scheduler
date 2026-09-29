# Palang Scheduler — data model

All event data lives in **Cloud Firestore** (Firebase project `palang-scheduler-c0365`).
Email addresses are **not** stored here; they live only in the Google Apps Script
(Script Properties), so they can't be read from the public site.

Each event has its own branch, so future events never mix with this one:

```
events/{eventId}                      ← one document per event (e.g. SLC_NYE_2026)
events/{eventId}/companions/{id}      ← one document per person (current state)
events/{eventId}/history/{autoId}     ← append-only log of every change
```

## `events/{eventId}`

| Field    | Type                 | Meaning |
|----------|----------------------|---------|
| `frozen` | boolean              | FREEZE switch from the admin page. `true` = public page is view-only. |
| `active` | map `id → colorIndex`| Everyone currently on the public list, with their color slot (0–14). Max 15. |

## `events/{eventId}/companions/{id}`

`id` = first 24 hex characters of SHA-256 of the person's lower-cased email.
The same email always maps to the same document, so re-submitting updates it.

| Field                | Type      | Meaning |
|----------------------|-----------|---------|
| `name`               | string    | Display name (≤ 60 chars). |
| `start`              | string    | First day, `YYYY-MM-DD`. |
| `end`                | string    | Last day, `YYYY-MM-DD` (inclusive). |
| `needsAccommodation` | boolean   | `false` if they ticked "I do not need accommodation". **Missing = `true`** (entries made before this field existed all need accommodation). |
| `color`              | number    | Color slot 0–14 (see `COLORS` in `assets/scheduler.js`). |
| `createdAt`          | timestamp | First time this person was added. |
| `updatedAt`          | timestamp | Last change. |
| `removed`            | boolean   | `true` once deleted from the public page. Records are never erased. |
| `removedAt`          | timestamp \| null | When they were removed. |

Derived values (compute, don't store):
- **Days** = `end − start + 1`
- **Nights** = `end − start`
- A person is **present on date D** when `start ≤ D ≤ end`
- **Counts toward accommodation** when `removed == false` and `needsAccommodation != false`

## `events/{eventId}/history/{autoId}`

Append-only; never edited or deleted.

| Field                | Type      | Meaning |
|----------------------|-----------|---------|
| `type`               | string    | `submit`, `rejoin`, `update`, `remove`, `freeze`, `unfreeze` |
| `name`, `start`, `end` | string  | Snapshot of the person's entry at that moment (absent for freeze/unfreeze). |
| `needsAccommodation` | boolean   | Snapshot at that moment (absent on older entries and on removes). |
| `at`                 | timestamp | When it happened. |

## Exports

The admin page's **Export CSV** gives one row per person ever added:
Name, First day, Last day, Days, Nights, Needs accommodation, Status, Added, Removed.
