import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import { catalogQueryOptions, refreshSessionCatalog } from "../../client-interface/query-options";
import { RefreshIcon } from "../../components/icons";
import { SessionNavigation } from "../session-catalog/SessionNavigation";

export function ConnectAppShell({ children }: { children: ReactNode }) {
  const catalog = useQuery(catalogQueryOptions);
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => await refreshSessionCatalog(queryClient),
  });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSettings = pathname === "/settings";
  const [mobileNav, setMobileNav] = useState({ isOpen: false, openedAtPath: pathname });
  const isMobileNavOpen = mobileNav.openedAtPath === pathname && mobileNav.isOpen;
  return (
    <AppShell
      variant="elevated"
      height="fill"
      contentPadding={0}
      topNav={
        <TopNav
          label="ClawChat Connect"
          heading={<TopNavHeading heading="ClawChat Connect" headingHref="/" />}
          endContent={
            <div className="top-nav-actions">
              <Button
                label="刷新全部 Session"
                isIconOnly
                icon={<RefreshIcon />}
                variant="ghost"
                size="sm"
                isLoading={catalog.isFetching || refresh.isPending}
                onClick={() => refresh.mutate()}
              />
              <Button
                label={isSettings ? "返回 Session" : "设置"}
                isIconOnly
                icon={<Icon icon={Settings} size="sm" />}
                variant={isSettings ? "secondary" : "ghost"}
                size="sm"
                onClick={() => void navigate({ to: isSettings ? "/" : "/settings" })}
              />
            </div>
          }
        />
      }
      sideNav={<SessionNavigation />}
      mobileNav={{
        breakpoint: "md",
        isOpen: isMobileNavOpen,
        onOpenChange: (isOpen) => setMobileNav({ isOpen, openedAtPath: pathname }),
      }}
    >
      {children}
    </AppShell>
  );
}
