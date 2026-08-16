import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, HardDrive, House, Link, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { HostDirectoryLocationView, WorkspaceDirectoryRequest } from "../../../../src/client-contract";
import { clientKeys, hostDirectories } from "../../client-interface/query-options";
import { localizedClientError, useClientTranslator } from "../../i18n/client-i18n";

export function HostDirectoryPicker({
  onCancel,
  onSelect,
}: {
  onCancel: () => void;
  onSelect: (directory: WorkspaceDirectoryRequest) => void;
}) {
  const t = useClientTranslator();
  const [path, setPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const listing = useQuery({
    queryKey: clientKeys.hostDirectories(path, showHidden),
    queryFn: async () => await hostDirectories(path, showHidden),
  });

  useEffect(() => {
    if (listing.data?.currentPath) setPathInput(listing.data.currentPath);
  }, [listing.data?.currentPath]);

  const openPath = (nextPath: string) => {
    const value = nextPath.trim();
    if (!value) return;
    setNewFolderName("");
    setPath(value);
  };
  const currentPath = listing.data?.currentPath ?? null;
  return (
    <VStack gap={4}>
      <VStack gap={2}>
        <HStack gap={2} align="end">
          <Button
            label={t("@connect.hostDirectory.parent")}
            icon={<Icon icon={Undo2} size="sm" />}
            variant="secondary"
            isDisabled={!listing.data?.parentPath}
            onClick={() => {
              const parent = listing.data?.parentPath;
              if (parent) openPath(parent);
            }}
          />
          <TextInput
            label={t("@connect.hostDirectory.path.label")}
            value={pathInput}
            onChange={setPathInput}
            placeholder={t("@connect.hostDirectory.path.placeholder")}
            width="100%"
          />
          <Button
            label={t("@connect.hostDirectory.open")}
            variant="secondary"
            isDisabled={!pathInput.trim()}
            onClick={() => openPath(pathInput)}
          />
        </HStack>
        <HStack gap={2} hAlign="between" align="center">
          <Text type="code" maxLines={1}>
            {currentPath ?? t("@connect.hostDirectory.chooseLocation")}
          </Text>
          <Button
            label={showHidden ? t("@connect.hostDirectory.hideHidden") : t("@connect.hostDirectory.showHidden")}
            variant="ghost"
            size="sm"
            onClick={() => setShowHidden((value) => !value)}
          />
        </HStack>
      </VStack>

      {listing.isError ? (
        <Banner
          status="error"
          title={t("@connect.hostDirectory.failure")}
          description={localizedClientError(t, listing.error)}
        />
      ) : null}

      <Section padding={0} dividers={["top", "bottom"]}>
        <List
          density="compact"
          hasDividers
          header={
            <Text type="label">
              {currentPath ? t("@connect.hostDirectory.directories") : t("@connect.hostDirectory.locations")}
            </Text>
          }
        >
          {currentPath
            ? [
                ...(listing.data?.entries ?? []).map((entry) => (
                  <ListItem
                    key={entry.path}
                    label={entry.name}
                    description={
                      entry.isSymbolicLink
                        ? t("@connect.hostDirectory.linkTarget", { path: entry.canonicalPath })
                        : entry.path
                    }
                    startContent={<Icon icon={entry.isSymbolicLink ? Link : Folder} size="sm" color="accent" />}
                    endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
                    onClick={() => openPath(entry.path)}
                  />
                )),
                ...(!listing.isPending && listing.data?.entries.length === 0
                  ? [<ListItem key="empty" label={t("@connect.hostDirectory.empty")} isDisabled />]
                  : []),
              ]
            : listing.data?.locations.map((location) => (
                <ListItem
                  key={location.id}
                  label={location.name}
                  description={location.path}
                  startContent={<Icon icon={locationIcon(location)} size="sm" color="accent" />}
                  endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
                  onClick={() => openPath(location.path)}
                />
              ))}
        </List>
      </Section>

      {currentPath ? (
        <VStack gap={2}>
          <HStack gap={2} align="end">
            <TextInput
              label={t("@connect.hostDirectory.newFolder.label")}
              value={newFolderName}
              onChange={setNewFolderName}
              placeholder={t("@connect.hostDirectory.newFolder.placeholder")}
              width="100%"
            />
            <Button
              label={t("@connect.hostDirectory.newFolder.use")}
              variant="secondary"
              isDisabled={!newFolderName.trim()}
              onClick={() => onSelect({ kind: "new-directory", parentPath: currentPath, name: newFolderName.trim() })}
            />
          </HStack>
          <HStack gap={2} hAlign="end">
            <Button label={t("@connect.hostDirectory.cancel")} variant="secondary" onClick={onCancel} />
            <Button
              label={t("@connect.hostDirectory.select")}
              variant="primary"
              onClick={() => onSelect({ kind: "existing-directory", rootPath: currentPath })}
            />
          </HStack>
        </VStack>
      ) : (
        <HStack gap={2} hAlign="end">
          <Button label={t("@connect.hostDirectory.cancel")} variant="secondary" onClick={onCancel} />
        </HStack>
      )}
    </VStack>
  );
}

export function workspaceDirectoryLabel(directory: WorkspaceDirectoryRequest, separator?: string): string {
  if (directory.kind === "existing-directory") return directory.rootPath;
  const pathSeparator = separator ?? (directory.parentPath.includes("\\") ? "\\" : "/");
  const parent =
    directory.parentPath.endsWith("/") || directory.parentPath.endsWith("\\")
      ? directory.parentPath.slice(0, -1)
      : directory.parentPath;
  return `${parent}${pathSeparator}${directory.name}`;
}

export function workspaceDirectoryName(directory: WorkspaceDirectoryRequest): string {
  if (directory.kind === "new-directory") return directory.name;
  const rootWithoutTrailingSeparators = directory.rootPath.replace(/[\\/]+$/u, "");
  if (!rootWithoutTrailingSeparators || /^[A-Za-z]:$/u.test(rootWithoutTrailingSeparators)) {
    return directory.rootPath;
  }
  return rootWithoutTrailingSeparators.split(/[\\/]/u).at(-1) ?? directory.rootPath;
}

function locationIcon(location: HostDirectoryLocationView) {
  if (location.kind === "home") return House;
  if (location.kind === "filesystem-root" || location.kind === "mounted-volume") return HardDrive;
  return Folder;
}
