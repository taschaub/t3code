import {
  AccessoryWidgetBackground,
  HStack,
  Image,
  Link,
  ProgressView,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  background,
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  multilineTextAlignment,
  padding,
  progressViewStyle,
  resizable,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { QuickActionsProps } from "./quickActionsSnapshot";

type QuickActionsConfiguration = { action?: "new" | "last" };

export function QuickActionsWidget(
  publishedProps: Partial<QuickActionsProps> | undefined,
  environment: WidgetEnvironment<QuickActionsConfiguration | undefined>,
) {
  "widget";
  // The extension evaluates this function without the app's module scope.
  // Before the app's first publish, the embedded layout renders with no props.
  const props = publishedProps ?? {};
  const family = environment.widgetFamily;
  // Gallery snapshots can render an old timeline entry after it has expired.
  const now = Math.max(environment.date?.getTime() ?? 0, Date.now());
  const isLightScheme = environment.colorScheme === "light";
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced === true;
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;
  const tileFill = { type: "hierarchical", style: "quinary" } as const;

  // Every build accepts the prod scheme as a link prefix.
  const newThreadUrl = props.newThreadUrl ?? "t3code://new";
  const lastThread = props.lastThread;
  const opensLastThread = environment.configuration?.action === "last";
  // Small and Lock Screen widgets have a single tap target.
  const tapUrl = opensLastThread ? lastThread?.url : newThreadUrl;

  if (family === "accessoryCircular") {
    return (
      <ZStack
        modifiers={[
          containerBackground("clear", "widget"),
          accessibilityLabel(opensLastThread ? "Last thread" : "New thread"),
          ...(tapUrl ? [widgetURL(tapUrl)] : []),
        ]}
      >
        <AccessoryWidgetBackground />
        <Image
          systemName={opensLastThread ? "clock.arrow.circlepath" : "square.and.pencil"}
          size={22}
        />
      </ZStack>
    );
  }

  const agents = props.agents && now < props.agents.staleAt ? props.agents : undefined;
  const waiting = agents?.waiting ?? 0;
  const working = agents?.working ?? 0;
  const waitingText = waiting > 0 ? `${waiting} need${waiting === 1 ? "s" : ""} you` : "";
  const workingText = working > 0 ? `${working} working` : "";
  const waitingTint = monochrome ? primary : isLightScheme ? "#d97706" : "#fcd34d";
  const workingTint = monochrome ? primary : isLightScheme ? "#0284c7" : "#7dd3fc";
  const statusText = (text: string, color: Parameters<typeof foregroundStyle>[0]) => (
    <Text
      modifiers={[
        font({ weight: "semibold", size: 11 }),
        foregroundStyle(color),
        lineLimit(1),
        layoutPriority(1),
      ]}
    >
      {text}
    </Text>
  );
  // What needs the user outranks what is merely running.
  const status = waitingText
    ? statusText(waitingText, waitingTint)
    : workingText
      ? statusText(workingText, workingTint)
      : null;

  // The template image ignores frame/foregroundStyle applied to itself; size
  // and tint it through a container the resizable image fills.
  const logo = (
    <HStack modifiers={[frame({ width: 19.5, height: 13 }), foregroundStyle(primary)]}>
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );
  const newThread = (
    <VStack alignment="leading" spacing={4}>
      <Image systemName="square.and.pencil" size={22} modifiers={[foregroundStyle(primary)]} />
      <Text
        modifiers={[font({ weight: "semibold", size: 15 }), foregroundStyle(primary), lineLimit(1)]}
      >
        New thread
      </Text>
    </VStack>
  );
  const lastThreadSummary = (titleLines: number) => (
    <VStack alignment="leading" spacing={1}>
      <Text modifiers={[font({ weight: "medium", size: 11 }), foregroundStyle(secondary)]}>
        Last thread
      </Text>
      <Text
        modifiers={[
          font({ weight: "semibold", size: lastThread ? 14 : 12 }),
          foregroundStyle(lastThread ? primary : secondary),
          lineLimit(lastThread ? titleLines : 3),
          multilineTextAlignment("leading"),
        ]}
      >
        {lastThread ? lastThread.title : "Open a thread in T3 Code to see it here"}
      </Text>
      {lastThread?.project ? (
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
          in {lastThread.project}
        </Text>
      ) : null}
    </VStack>
  );
  const cardBackground = containerBackground(isLightScheme ? "#ffffff" : "#1c1c1e", "widget");

  if (family === "systemSmall") {
    return (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[cardBackground, ...(tapUrl ? [widgetURL(tapUrl)] : [])]}
      >
        <HStack alignment="center" spacing={6}>
          {logo}
          <Spacer minLength={0} />
          {status}
        </HStack>
        <Spacer minLength={6} />
        {lastThreadSummary(2)}
        <Spacer minLength={6} />
        {tapUrl ? (
          <HStack
            alignment="center"
            spacing={5}
            modifiers={[
              padding({ horizontal: 10, vertical: 6 }),
              background({ type: "hierarchical", style: "quaternary" }),
              clipShape("capsule"),
            ]}
          >
            <Image
              systemName={opensLastThread ? "arrow.up.forward" : "square.and.pencil"}
              size={12}
              modifiers={[foregroundStyle(primary)]}
            />
            <Text
              modifiers={[
                font({ weight: "semibold", size: 12 }),
                foregroundStyle(primary),
                lineLimit(1),
              ]}
            >
              {opensLastThread ? "Open thread" : "New thread"}
            </Text>
          </HStack>
        ) : null}
      </VStack>
    );
  }

  const tile = (content: React.ReactElement, header: React.ReactElement | null) => (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[
        padding({ all: 12 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "leading" }),
        background(tileFill),
        clipShape("roundedRectangle", 14),
      ]}
    >
      {header}
      <Spacer minLength={6} />
      {content}
    </VStack>
  );
  const actions = (header: React.ReactElement | null) => (
    <HStack spacing={8}>
      <Link destination={newThreadUrl}>{tile(newThread, header)}</Link>
      {lastThread ? (
        <Link destination={lastThread.url}>{tile(lastThreadSummary(2), null)}</Link>
      ) : (
        tile(lastThreadSummary(2), null)
      )}
    </HStack>
  );

  if (family !== "systemLarge") {
    return (
      <VStack modifiers={[cardBackground]}>
        {actions(
          <HStack alignment="center" spacing={6}>
            {logo}
            <Spacer minLength={0} />
            {status}
          </HStack>,
        )}
      </VStack>
    );
  }

  const providers = props.usage?.providers ?? [];
  const usage = (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[
        padding({ all: 12 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "leading" }),
        background(tileFill),
        clipShape("roundedRectangle", 14),
      ]}
    >
      {providers.length === 0 ? (
        <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(2)]}>
          {props.usage ? "No subscription limits available" : "Open T3 Code to load usage"}
        </Text>
      ) : (
        <HStack alignment="top" spacing={14}>
          {providers.slice(0, 2).map((provider) => {
            const stale = provider.windows.length > 0 && now >= provider.expiresAt;
            const windows = stale ? [] : provider.windows;
            const preferred = [
              windows.find((window) => window.kind === "session"),
              windows.find((window) => window.kind === "weekly"),
            ].filter((window) => window !== undefined);
            const shown = [
              ...preferred,
              ...windows.filter((window) => !preferred.includes(window)),
            ].slice(0, 3);
            return (
              <VStack
                key={provider.name}
                alignment="leading"
                spacing={5}
                modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
              >
                <Text
                  modifiers={[
                    font({ weight: "semibold", size: 13 }),
                    foregroundStyle(primary),
                    lineLimit(1),
                  ]}
                >
                  {provider.name}
                </Text>
                {shown.length === 0 ? (
                  <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(2)]}>
                    {stale
                      ? "Open T3 to refresh"
                      : provider.windows.length === 0 && provider.expiresAt > 0
                        ? "No limits available"
                        : provider.detail}
                  </Text>
                ) : null}
                {shown.map((window) => (
                  <VStack key={window.label} alignment="leading" spacing={2}>
                    <HStack spacing={4}>
                      <Text
                        modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}
                      >
                        {window.label}
                      </Text>
                      <Spacer minLength={0} />
                      <Text
                        modifiers={[
                          font({ weight: "semibold", size: 11 }),
                          foregroundStyle(primary),
                          lineLimit(1),
                          layoutPriority(1),
                        ]}
                      >
                        {window.remaining}% left
                      </Text>
                    </HStack>
                    <ProgressView
                      value={window.remaining / 100}
                      modifiers={[
                        progressViewStyle("linear"),
                        frame({ height: 4 }),
                        ...(monochrome
                          ? []
                          : [tint(provider.name === "Claude" ? "#d97757" : "#8e8e93")]),
                      ]}
                    />
                    <Text
                      modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}
                    >
                      {window.reset}
                    </Text>
                  </VStack>
                ))}
              </VStack>
            );
          })}
        </HStack>
      )}
      <Spacer minLength={0} />
      {providers.length > 0 && props.usage?.checkedAt ? (
        <Text modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}>
          As of{" "}
          {new Date(props.usage.checkedAt).toLocaleString(undefined, {
            hour: "numeric",
            minute: "2-digit",
            month: "short",
            day: "numeric",
          })}
        </Text>
      ) : null}
    </VStack>
  );
  return (
    <VStack alignment="leading" spacing={8} modifiers={[cardBackground]}>
      <HStack alignment="center" spacing={8}>
        {logo}
        <Spacer minLength={0} />
        {waitingText ? statusText(waitingText, waitingTint) : null}
        {workingText ? statusText(workingText, workingTint) : null}
        {agents && !waitingText && !workingText ? statusText("No agents running", secondary) : null}
      </HStack>
      <HStack modifiers={[frame({ height: 92 })]}>{actions(null)}</HStack>
      {props.usage?.url ? <Link destination={props.usage.url}>{usage}</Link> : usage}
    </VStack>
  );
}

export default createWidget<Partial<QuickActionsProps>>("QuickActions", QuickActionsWidget);
