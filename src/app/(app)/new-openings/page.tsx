import { redirect } from "next/navigation";

// The New openings view was merged into the Leads page as a filter
// (/leads?openings=1). This route just forwards there for any old links.
export default function NewOpeningsPage() {
  redirect("/leads?openings=1");
}
