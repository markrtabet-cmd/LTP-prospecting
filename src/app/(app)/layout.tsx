import { Sidebar } from "@/components/Sidebar";
import { Assistant } from "@/components/Assistant";
import { RestaurantsProvider } from "@/lib/store";
import { MeetingsProvider } from "@/lib/meetings-store";
import { RepProvider } from "@/lib/rep";
import { MobileRedirect } from "@/components/MobileRedirect";

// Shared shell for all authenticated pages. Access is enforced by middleware.ts.
// RestaurantsProvider holds the shared data for every page; RepProvider knows
// who is signed in; MeetingsProvider holds the visit calendar. The Assistant
// lives inside them so it can read and mutate the same stores.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RepProvider>
      <RestaurantsProvider>
        <MeetingsProvider>
          <MobileRedirect />
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto p-6">{children}</main>
          </div>
          <div className="hidden md:block"><Assistant /></div>
        </MeetingsProvider>
      </RestaurantsProvider>
    </RepProvider>
  );
}
