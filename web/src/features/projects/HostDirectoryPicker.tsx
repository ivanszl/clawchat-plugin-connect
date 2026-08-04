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
import type { HostDirectoryLocationView, ProjectDirectoryRequest } from "../../../../src/client-contract";
import { clientKeys, hostDirectories } from "../../client-interface/query-options";

export function HostDirectoryPicker({
  onCancel,
  onSelect,
}: {
  onCancel: () => void;
  onSelect: (directory: ProjectDirectoryRequest) => void;
}) {
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
            label="返回上级"
            icon={<Icon icon={Undo2} size="sm" />}
            variant="secondary"
            isDisabled={!listing.data?.parentPath}
            onClick={() => {
              const parent = listing.data?.parentPath;
              if (parent) openPath(parent);
            }}
          />
          <TextInput
            label="主机绝对路径"
            value={pathInput}
            onChange={setPathInput}
            placeholder="输入 Connect 主机上的绝对路径"
            width="100%"
          />
          <Button label="打开" variant="secondary" isDisabled={!pathInput.trim()} onClick={() => openPath(pathInput)} />
        </HStack>
        <HStack gap={2} hAlign="between" align="center">
          <Text type="code" maxLines={1}>
            {currentPath ?? "选择一个主机位置"}
          </Text>
          <Button
            label={showHidden ? "隐藏点目录" : "显示隐藏目录"}
            variant="ghost"
            size="sm"
            onClick={() => setShowHidden((value) => !value)}
          />
        </HStack>
      </VStack>

      {listing.isError ? <Banner status="error" title="无法打开目录" description={listing.error.message} /> : null}

      <Section padding={0} dividers={["top", "bottom"]}>
        <List density="compact" hasDividers header={<Text type="label">{currentPath ? "目录" : "位置"}</Text>}>
          {currentPath
            ? [
                ...(listing.data?.entries ?? []).map((entry) => (
                  <ListItem
                    key={entry.path}
                    label={entry.name}
                    description={entry.isSymbolicLink ? `链接到 ${entry.canonicalPath}` : entry.path}
                    startContent={<Icon icon={entry.isSymbolicLink ? Link : Folder} size="sm" color="accent" />}
                    endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
                    onClick={() => openPath(entry.path)}
                  />
                )),
                ...(!listing.isPending && listing.data?.entries.length === 0
                  ? [<ListItem key="empty" label="没有可显示的子目录" isDisabled />]
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
              label="新建文件夹"
              value={newFolderName}
              onChange={setNewFolderName}
              placeholder="输入单个目录名"
              width="100%"
            />
            <Button
              label="使用新文件夹"
              variant="secondary"
              isDisabled={!newFolderName.trim()}
              onClick={() => onSelect({ kind: "new-directory", parentPath: currentPath, name: newFolderName.trim() })}
            />
          </HStack>
          <HStack gap={2} hAlign="end">
            <Button label="取消" variant="secondary" onClick={onCancel} />
            <Button
              label="选择此目录"
              variant="primary"
              onClick={() => onSelect({ kind: "existing-directory", rootPath: currentPath })}
            />
          </HStack>
        </VStack>
      ) : (
        <HStack gap={2} hAlign="end">
          <Button label="取消" variant="secondary" onClick={onCancel} />
        </HStack>
      )}
    </VStack>
  );
}

export function projectDirectoryLabel(directory: ProjectDirectoryRequest, separator?: string): string {
  if (directory.kind === "existing-directory") return directory.rootPath;
  const pathSeparator = separator ?? (directory.parentPath.includes("\\") ? "\\" : "/");
  const parent =
    directory.parentPath.endsWith("/") || directory.parentPath.endsWith("\\")
      ? directory.parentPath.slice(0, -1)
      : directory.parentPath;
  return `${parent}${pathSeparator}${directory.name}`;
}

function locationIcon(location: HostDirectoryLocationView) {
  if (location.kind === "home") return House;
  if (location.kind === "filesystem-root" || location.kind === "mounted-volume") return HardDrive;
  return Folder;
}
