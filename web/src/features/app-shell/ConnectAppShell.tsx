import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Stack";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  bootstrapQueryOptions,
  catalogQueryOptions,
  projectsQueryOptions,
  refreshSessionCatalog,
} from "../../client-interface/query-options";
import { RefreshIcon } from "../../components/icons";
import { NewSessionDialog, SessionNavigation } from "../session-catalog/SessionNavigation";

export function ConnectAppShell({ children }: { children: ReactNode }) {
  const catalog = useQuery(catalogQueryOptions);
  const bootstrap = useQuery(bootstrapQueryOptions);
  const projects = useQuery(projectsQueryOptions);
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => await refreshSessionCatalog(queryClient),
  });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSettings = pathname === "/settings";
  const [mobileNav, setMobileNav] = useState({ isOpen: false, openedAtPath: pathname });
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const isMobileNavOpen = mobileNav.openedAtPath === pathname && mobileNav.isOpen;
  return (
    <>
      <AppShell
        variant="elevated"
        height="fill"
        contentPadding={0}
        topNav={
          <TopNav
            label="ClawChat Connect"
            heading={<TopNavHeading heading="ClawChat Connect" headingHref="/" />}
            endContent={
              <HStack gap={1} align="center">
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
              </HStack>
            }
          />
        }
        sideNav={
          <SessionNavigation
            onNewSession={() => {
              setMobileNav({ isOpen: false, openedAtPath: pathname });
              setNewSessionOpen(true);
            }}
          />
        }
        mobileNav={{
          breakpoint: "md",
          isOpen: isMobileNavOpen,
          onOpenChange: (isOpen) => setMobileNav({ isOpen, openedAtPath: pathname }),
        }}
      >
        {children}
      </AppShell>
      <NewSessionDialog
        isOpen={newSessionOpen}
        bindings={bootstrap.data?.bindings ?? []}
        catalogBindings={catalog.data?.bindings ?? []}
        projects={projects.data ?? []}
        onOpenChange={setNewSessionOpen}
        onCreated={(sessionRef) => {
          setNewSessionOpen(false);
          requestAnimationFrame(() => {
            void navigate({ to: "/sessions/$sessionRef", params: { sessionRef } });
          });
        }}
      />
    </>
  );
}
