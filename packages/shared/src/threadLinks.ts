import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { webOrigin } from "./url.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const V1_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const V2_PREFIX = `${THREAD_LINK_PROTOCOL}://v2/`;
const V3_PREFIX = `${THREAD_LINK_PROTOCOL}://v3/`;
const HOSTED_SEGMENT = "[A-Za-z0-9_%-]+";
const THREAD_HREF = String.raw`t3-thread:\/\/v[123]\/`;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
const NOT_INSIDE_A_LONGER_URL = {
  before: String.raw`(?<![A-Za-z0-9%/?#=&@+-])`,
  after: String.raw`(?![\w%/?#-])`,
};

function hostedThreadPrefix(hostedOrigin: string | undefined): string | undefined {
  const origin = webOrigin(hostedOrigin);
  return origin === undefined ? undefined : `${origin}/threads/`;
}

function makeThreadLinkPattern(hostedPrefix: string | undefined): RegExp {
  const hostedLink =
    hostedPrefix === undefined
      ? undefined
      : `${hostedPrefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${HOSTED_SEGMENT}/${HOSTED_SEGMENT}`;
  const orHosted = hostedLink === undefined ? "" : `|${hostedLink}`;
  // Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
  // nothing, code is literal, and a link to anywhere else keeps a thread URL in its label or href.
  const alternatives = [
    String.raw`\\[!-/:-@[-\`{-~]`,
    String.raw`(?<fence>(\`{3,}|~{3,})[\s\S]*?(?:\2|$))`,
    String.raw`(?<span>(\`+)[^\n]*?\4)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[(?<label>${LABEL})\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+${orHosted})>|(?<href>${THREAD_HREF}[^\s>)]+${orHosted}))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
    String.raw`<(?<autolink>${THREAD_HREF}[^\s<>]+${orHosted})>`,
  ];
  if (hostedLink !== undefined) {
    const { before, after } = NOT_INSIDE_A_LONGER_URL;
    alternatives.push(String.raw`${before}(?<bare>${hostedLink})${after}`);
  }
  return new RegExp(alternatives.join("|"), "g");
}

const THREAD_LINK_PATTERN = makeThreadLinkPattern(undefined);
let lastHostedPattern: { readonly prefix: string; readonly pattern: RegExp } | undefined;

function threadLinkPattern(hostedPrefix: string | undefined): RegExp {
  if (hostedPrefix === undefined) return THREAD_LINK_PATTERN;
  if (lastHostedPattern?.prefix !== hostedPrefix) {
    lastHostedPattern = { prefix: hostedPrefix, pattern: makeThreadLinkPattern(hostedPrefix) };
  }
  return lastHostedPattern.pattern;
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** A v1 link names no environment; the message's own, or a unique match, stands in. */
export interface ThreadLink {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId;
}

// Escapes even URL-safe punctuation, so a sentence's closing period never reads as part of an id.
const escapedSegment = (id: string) =>
  encodeURIComponent(id).replace(
    /[.!~*'()]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function hostedThreadLink(ref: ScopedThreadRef, origin: string): string {
  const path = `/threads/${escapedSegment(ref.environmentId)}/${escapedSegment(ref.threadId)}`;
  return new URL(path, origin).toString();
}

const HOSTED_PATH = new RegExp(`^(${HOSTED_SEGMENT})/(${HOSTED_SEGMENT})$`);

function percentDecoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseEscapedThreadLink(href: string, prefix: string): ThreadLink | null {
  const match = HOSTED_PATH.exec(href.slice(prefix.length));
  if (!match) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(percentDecoded(match[1]!)));
  const threadId = Option.getOrNull(decodeThreadId(percentDecoded(match[2]!)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

/**
 * A v1 or v2 link's ids as written, since thread ids can hold percent escapes of their own;
 * candidates also try a thread id decoded. A v3 or hosted link escapes both ids, so they are decoded.
 */
export function parseThreadLinkHref(href: string, hostedOrigin?: string): ThreadLink | null {
  const hostedPrefix = hostedThreadPrefix(hostedOrigin);
  if (hostedPrefix !== undefined && href.startsWith(hostedPrefix)) {
    return parseEscapedThreadLink(href, hostedPrefix);
  }
  if (href.startsWith(V3_PREFIX)) return parseEscapedThreadLink(href, V3_PREFIX);
  if (href.startsWith(V1_PREFIX)) {
    const threadId = Option.getOrNull(decodeThreadId(href.slice(V1_PREFIX.length)));
    return threadId === null ? null : { environmentId: null, threadId };
  }
  if (!href.startsWith(V2_PREFIX)) return null;
  const path = href.slice(V2_PREFIX.length);
  const slash = path.indexOf("/");
  if (slash < 0) return null;
  const environmentId = Option.getOrNull(decodeEnvironmentId(path.slice(0, slash)));
  const threadId = Option.getOrNull(decodeThreadId(path.slice(slash + 1)));
  return environmentId === null || threadId === null ? null : { environmentId, threadId };
}

function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  const decoded = percentDecoded(threadId);
  return decoded === null || decoded === threadId
    ? null
    : Option.getOrNull(decodeThreadId(decoded));
}

/** The threads a link can name, in its own environment or else the message's: as written, then decoded. */
export function threadLinkCandidates(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  const environmentId = link.environmentId ?? messageEnvironmentId;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  const written = { environmentId, threadId: link.threadId };
  return decodedId === null ? [written] : [written, { environmentId, threadId: decodedId }];
}

/** A v1 link its message's environment lacks opens a unique match elsewhere; a v2 link never does. */
export function guessThreadLinkRef(
  link: ThreadLink,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  if (link.environmentId !== null) return null;
  const decodedId = percentDecodedThreadLinkId(link.threadId);
  for (const threadId of decodedId === null ? [link.threadId] : [link.threadId, decodedId]) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

// `&` could start a character reference, which a Markdown renderer decodes.
const WRITTEN_AS_IS = /^[\w\-.~:@!$'()*+,;=%/]+$/;

function threadLinkHref({ environmentId, threadId }: ThreadLink): string {
  if (environmentId === null) {
    return `${V1_PREFIX}${WRITTEN_AS_IS.test(threadId) ? threadId : escapedSegment(threadId)}`;
  }
  return WRITTEN_AS_IS.test(threadId) &&
    WRITTEN_AS_IS.test(environmentId) &&
    !environmentId.includes("/")
    ? `${V2_PREFIX}${environmentId}/${threadId}`
    : `${V3_PREFIX}${escapedSegment(environmentId)}/${escapedSegment(threadId)}`;
}

const linkLabel = (label: string | undefined) =>
  label
    ?.replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Without a label, an autolink: clients show the thread's current title. */
export function formatThreadLink(ref: ThreadLink, label?: string): string {
  const cleaned = linkLabel(label);
  const href = threadLinkHref(ref);
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return cleaned ? `[${cleaned}](${destination})` : `<${href}>`;
}

/** What a person copies out of T3 Code: a link into the web app at `origin`, else a v2 link. */
export function formatHostedThreadLink(
  ref: ScopedThreadRef,
  label: string,
  origin: string | undefined,
): string {
  const webAppOrigin = webOrigin(origin);
  if (webAppOrigin === undefined) return formatThreadLink(ref, label);
  const href = hostedThreadLink(ref, webAppOrigin);
  const cleaned = linkLabel(label);
  return cleaned ? `[${cleaned}](${href})` : href;
}

export function hasThreadLinks(markdown: string, hostedOrigin?: string): boolean {
  const hostedPrefix = hostedThreadPrefix(hostedOrigin);
  return (
    markdown.includes(`${THREAD_LINK_PROTOCOL}://v`) ||
    (hostedPrefix !== undefined && markdown.includes(hostedPrefix))
  );
}

/** Every thread the markdown's links can name, so their titles are keyed reads. */
export function threadLinkRefs(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  hostedOrigin?: string,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  // Hermes' matchAll yields matches without `groups`; exec keeps them.
  const pattern = new RegExp(threadLinkPattern(hostedThreadPrefix(hostedOrigin)));
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    const href =
      match.groups?.angleHref ?? match.groups?.href ?? match.groups?.autolink ?? match.groups?.bare;
    const link = href === undefined ? null : parseThreadLinkHref(href, hostedOrigin);
    if (link === null) continue;
    for (const ref of threadLinkCandidates(link, messageEnvironmentId)) {
      refs.set(`${ref.environmentId}/${ref.threadId}`, ref);
    }
  }
  return [...refs.values()];
}

/** Rewrites each link outside code `replace` answers for. `label` is a Markdown link's own text. */
export function replaceThreadLinks(
  markdown: string,
  replace: (link: ThreadLink, label: string | undefined) => string | undefined,
  hostedOrigin?: string,
): string {
  if (!hasThreadLinks(markdown, hostedOrigin)) return markdown;
  return markdown.replace(
    threadLinkPattern(hostedThreadPrefix(hostedOrigin)),
    (source, ...args) => {
      const groups = args.at(-1) as Partial<
        Record<"angleHref" | "href" | "autolink" | "bare" | "label", string>
      >;
      const href = groups.angleHref ?? groups.href ?? groups.autolink ?? groups.bare;
      const link = href === undefined ? null : parseThreadLinkHref(href, hostedOrigin);
      return (link && replace(link, groups.label)) ?? source;
    },
  );
}
