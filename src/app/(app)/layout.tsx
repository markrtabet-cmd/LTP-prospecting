import { Sidebar } from "@/components/Sidebar";
import { Assistant } from "@/components/Assistant";
import { TopBar } from "@/components/TopBar";
import { RestaurantsProvider } from "@/lib/store";
import { MeetingsProvider } from "@/lib/meetings-store";
import { RepProvider } from "@/lib/rep";
import { MobileRedirect } from "@/components/MobileRedirect";
import { RecordMeetingBridge } from "@/components/RecordMeetingBridge";

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
            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar />
              <main className="flex-1 overflow-y-auto p-6">{children}</main>
            </div>
          </div>
          <div className="hidden md:block"><Assistant /></div>
          {/* Opens the meeting recorder for Lumen's record_meeting action on every
              surface (the mobile map is no longer the sole listener). */}
          <RecordMeetingBridge />
        </MeetingsProvider>
      </RestaurantsProvider>
    </RepProvider>
  );
}
