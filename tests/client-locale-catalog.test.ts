import { describe, expect, it } from "bun:test";
import { isStructurallySame, parse } from "@formatjs/icu-messageformat-parser";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { clientMessages } from "../web/src/i18n/catalogs";
import type { ClientMessageKey } from "../web/src/i18n/catalogs/en";
// @ts-expect-error The service tsconfig intentionally has no JSX; Bun loads the production locale provider for this seam.
import { ClientInternationalizationProvider, useClientTranslator } from "../web/src/i18n/client-i18n";
import { type ClientLocale, clientLocales } from "../web/src/i18n/client-locale";

describe("Connect Client locale catalogs", () => {
  it("keeps every locale aligned with the English source catalog and its ICU arguments", () => {
    expect(clientLocales).toEqual(["zh-Hans", "zh-Hant", "en", "ja", "es", "ko"]);
    const sourceKeys = (Object.keys(clientMessages.en) as ClientMessageKey[]).sort();
    expect(sourceKeys).toContain("@astryx.appShell.skipToContent");
    expect(Object.keys(clientMessages).sort()).toEqual([...clientLocales].sort());

    for (const locale of clientLocales) {
      const catalog = clientMessages[locale];
      expect(Object.keys(catalog).sort()).toEqual(sourceKeys);
      for (const key of sourceKeys) {
        expect(messageArguments(catalog[key].defaultMessage)).toEqual(
          messageArguments(clientMessages.en[key].defaultMessage),
        );
        const structuralMatch = isStructurallySame(
          parse(clientMessages.en[key].defaultMessage),
          parse(catalog[key].defaultMessage),
        );
        expect(structuralMatch.success).toBe(true);
      }
    }
  });

  it("keeps Connect-owned visible JSX literals behind the locale catalog", async () => {
    const reviewedLiteralAllowlist = new Set([
      "web/src/features/app-shell/ConnectAppShell.tsx::ClawChat Connect",
      "web/src/features/session-catalog/SessionNavigation.tsx::Project",
      "web/src/features/settings/SettingsPage.tsx::CONNECT CLIENT",
      "web/src/features/transcript/TranscriptBlockView.tsx::ClawChat",
    ]);
    const unlocalized: string[] = [];
    const glob = new Bun.Glob("web/src/**/*.tsx");
    for await (const path of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
      if (path.endsWith("routeTree.gen.tsx")) continue;
      const source = ts.createSourceFile(
        path,
        await Bun.file(path).text(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      for (const literal of visibleJsxLiterals(source)) {
        const allowlistKey = `${path}::${literal.value}`;
        if (reviewedLiteralAllowlist.has(allowlistKey)) continue;
        const position = source.getLineAndCharacterOfPosition(literal.position);
        unlocalized.push(`${path}:${position.line + 1} ${JSON.stringify(literal.value)}`);
      }
    }
    expect(unlocalized).toEqual([]);
  });

  it("formats plural quantities and time units with the selected locale", () => {
    expect(renderFormattingProbe("en")).toContain("12,345 seconds remaining");
    expect(renderFormattingProbe("es")).toContain("Quedan 12.345 segundos");
  });
});

function FormattingProbe() {
  const t = useClientTranslator();
  return createElement("p", null, t("@connect.interaction.remainingSeconds", { count: 12_345 }));
}

function renderFormattingProbe(locale: ClientLocale): string {
  return renderToStaticMarkup(
    createElement(ClientInternationalizationProvider, { locale }, createElement(FormattingProbe)),
  );
}

const visibleAttributeNames = new Set([
  "actionLabel",
  "alt",
  "aria-label",
  "cancelLabel",
  "description",
  "disabledMessage",
  "label",
  "placeholder",
  "title",
]);

function visibleJsxLiterals(source: ts.SourceFile): Array<{ value: string; position: number }> {
  const literals: Array<{ value: string; position: number }> = [];
  const record = (value: string, position: number) => {
    const normalized = value.trim().replace(/\s+/gu, " ");
    if (/[\p{L}\p{N}]/u.test(normalized)) literals.push({ value: normalized, position });
  };
  const recordExpression = (expression: ts.Expression): void => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      record(expression.text, expression.getStart(source));
    } else if (ts.isTemplateExpression(expression)) {
      record(expression.head.text, expression.head.getStart(source));
      for (const span of expression.templateSpans) record(span.literal.text, span.literal.getStart(source));
    } else if (ts.isConditionalExpression(expression)) {
      recordExpression(expression.whenTrue);
      recordExpression(expression.whenFalse);
    } else if (ts.isBinaryExpression(expression)) {
      recordExpression(expression.left);
      recordExpression(expression.right);
    } else if (ts.isParenthesizedExpression(expression)) {
      recordExpression(expression.expression);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) record(node.text, node.getStart(source));
    if (ts.isJsxAttribute(node) && visibleAttributeNames.has(node.name.getText(source))) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        record(node.initializer.text, node.initializer.getStart(source));
      } else if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        recordExpression(node.initializer.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

function messageArguments(message: string): string[] {
  return [...message.matchAll(/\{\s*([a-z][a-z0-9_]*)\s*(?:,|\})/giu)].map((match) => match[1] ?? "").sort();
}
