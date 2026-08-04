import { EmptyState } from "@astryxdesign/core/EmptyState";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { createFileRoute } from "@tanstack/react-router";
import { ThreadIcon } from "../components/icons";
import { useClientTranslator } from "../i18n/client-i18n";

export const Route = createFileRoute("/")({ component: ConnectHome });

function ConnectHome() {
  const t = useClientTranslator();
  return (
    <VStack as="section" className="home-page" align="center" justify="center">
      <VStack className="home-grid" aria-hidden="true" />
      <EmptyState
        headingLevel={1}
        icon={<ThreadIcon className="empty-icon" />}
        title={t("@connect.home.title")}
        description={t("@connect.home.description")}
      />
      <Text as="p" className="home-note">
        {t("@connect.home.note")}
      </Text>
    </VStack>
  );
}
