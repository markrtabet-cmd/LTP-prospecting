import { redirect } from "next/navigation";

// Root simply forwards into the app. The middleware decides whether the user
// lands on the dashboard or gets bounced to /login.
export default function Home() {
  redirect("/dashboard");
}
