import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ConnectMark, SettingsIcon } from "../../components/icons";
import { SessionNavigation } from "../session-catalog/SessionNavigation";

export function ConnectAppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isSettings = useRouterState({ select: (state) => state.location.pathname === "/settings" });
  return (
    <AppShell
      variant="elevated"
      height="fill"
      contentPadding={0}
      topNav={
        <TopNav
          label="Connect Client"
          heading={
            <TopNavHeading
              logo={<ConnectMark className="brand-mark" />}
              heading="Connect"
              subheading="Local agent relay"
              headingHref="/"
            />
          }
          endContent={
            <Button
              label={isSettings ? "返回 Session" : "设置"}
              icon={<SettingsIcon />}
              variant={isSettings ? "secondary" : "ghost"}
              size="sm"
              onClick={() => void navigate({ to: isSettings ? "/" : "/settings" })}
            />
          }
        />
      }
      sideNav={<SessionNavigation />}
      mobileNav={{ breakpoint: "md" }}
    >
      {children}
    </AppShell>
  );
}
