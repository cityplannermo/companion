# Changelog

All notable changes to Wiki Companion are recorded here, newest first. Earlier history (before this file existed) is in the [commit log](https://github.com/cityplannermo/companion/commits/main) and the version history in [releases](https://github.com/cityplannermo/companion/releases).

## 1.33.1

Cleared two flags from 1.33.0's automated review: an unsafe (untyped) value passed into a function expecting a string when reading an invoice's currency, and an unused import left behind in the shared item editor.

## 1.33.0

- **Invoices**: the total is now written to an `amount` (and `currency`) frontmatter field when an invoice is generated, instead of being read back out of the invoice's own body text. Older invoices still work exactly as before.
- **Task board**: right-click with two or more tasks selected now offers "Move to To Do/Doing/Done" and "Set/Clear priority" for the whole selection, alongside the existing bulk delete.
- **Reminders and Tasks**: the "+" button on each tab now opens the same full editor the calendar uses (date, repeat, an advance reminder, and for tasks also status and priority), replacing the old title-only quick-add box.
- **Time tracker**: the Report page gained a client filter and a custom date range, on top of the existing month browser. Its stat row now shows six figures at a glance (Today, This week, This month, the browsed period's total, billable hours, and the overall unbilled total), replacing the plain text summary that used to sit on the Log page.
- **Settings**: every tab except the calendar can now be switched off individually, and Finance's four sections (Subscriptions, Expenses, Income, Invoiced) can be hidden independently of the tab as a whole.
- **Mobile**: a header with too many controls to fit on one line now collapses the less-used ones into a "⋮" menu, instead of wrapping onto a second or third line.
- **New: Posts gallery.** A card view over every post-tagged note, for tracking blog and social content through to publication. Add-only, same as the calendar's existing read-only post pins.
- Copy across the README and plugin listing refreshed to reflect that this is a general tool for freelancers and consultants, not something built only for one particular vault.
