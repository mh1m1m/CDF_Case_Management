// The command-form contract moved to @cdf/ui as CDFCommandForm (RC-01, UX-001). This alias keeps the one
// remaining import (intake/[id]/page.tsx, which another change owns) working; new code imports CDFCommandForm.
export { CDFCommandForm as ActionForm } from "@cdf/ui";
