# Corpus admin design review

Open `direction-a.html` or `direction-b.html` directly in a browser. No server or build step needed. The font loads from Google Fonts, with a system font fallback offline.

- **A — Operations console:** compact rows and immediate visibility of failed jobs. Recommended for frequent infrastructure work and incident triage.
- **B — Service dashboard:** larger cards, more space, and service health before job details. Recommended for occasional administration; less information fits above the fold.

Both include Overview, Jobs, Integrations, Users & workspaces, and Audit log. Use sidebar or tabs to switch views. Use Preview state for populated, loading, empty, and error states. In Jobs, History opens run details with Run now and Pause job. In Users, search and View user expose account details and Disable user. Pause and disable open a modal with impact copy and a required audit reason. Escape closes dialogs; native modal dialogs contain keyboard focus.

All values and actions are fictional. Production is an environment cue, not a live connection. These prototypes do not define backend contracts or perform actual admin actions. The image comparison is conceptual; the HTML is the reviewable interaction reference.

## Design handoff

Tokens match `apps/web/src/routes/layout.css`: primary #2c87f2, canvas #f7f8fa, surface #fff, ink #111827, muted #6b7280, line #e9ebef, Plus Jakarta Sans. Layout follows the existing Sidebar and Topbar. App implementation should reuse Modal, EmptyState, Avatar, Icon, and the existing UI primitives. Static HTML reproduces these treatments without requiring a Svelte runtime.

Persistent ADMIN and Production labels distinguish this surface. Status always has text as well as color. Confirmation names the exact target and impact; its default focus is Cancel. Keep existing data visible when background refresh fails in the production implementation, including last successful refresh time.

Approval needed: choose A or B (or a hybrid), confirm initial operational scope, and settle access/deployment with Lead before production implementation.
