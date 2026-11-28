/**
 * Routes phase: the definition-level `HANDLES_ROUTE` edge and the
 * `Route.handlerSymbolId` stamp, both gated on the handler symbol EXISTING in
 * the graph.
 *
 * `routeHandlerSymbols` carries `SemanticModel` node ids, which are a
 * resolution claim rather than proof that the definition node reached
 * `ctx.graph`. Two directions are pinned here:
 *
 *   • resolved — a live `Function` / `Method` node gets BOTH the file-level edge
 *     (what `http-route-extractor.ts` queries) and the definition-level edge, so
 *     a HANDLES_ROUTE traversal reaches the handler and not just its file;
 *   • dangling — an id with no node in the graph falls back to exactly the
 *     file-level behavior a route with no handler resolution has: file-level
 *     edge only, no `handlerSymbolId` stamp, and no edge sourced on a node that
 *     does not exist.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NodeLabel } from 'gitnexus-shared';
import { routesPhase } from '../../src/core/ingestion/pipeline-phases/routes.js';
import { routeNodeKey } from '../../src/core/ingestion/route-extractors/route-path.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../src/core/ingestion/route-extractors/data-route-table.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

const CONTROLLER = 'src/orders/controller.ts';
const TABLE_FILE = 'src/routes/table.ts';
const HANDLER_FILE = 'src/handlers/orders.ts';
const HANDLER_SOURCE = `export function createOrder() {\n  return { id: 1 };\n}\n`;

interface RunOptions {
  /** Files to materialize in the temp repo, path → contents. */
  readonly files?: Readonly<Record<string, string>>;
  /** Handler definition node to seed into the graph before the phase runs. */
  readonly handlerNode?: {
    id: string;
    label: NodeLabel;
    filePath: string;
    /** 0-based, inclusive; the first three lines of the file by default. */
    lines?: readonly [number, number];
  };
  readonly routeHandlerSymbols: ReadonlyMap<string, string>;
  readonly extractedRoutes?: readonly unknown[];
  readonly decoratorRoutes?: readonly unknown[];
}

async function runRoutesPhase(
  options: RunOptions,
): Promise<{ graph: KnowledgeGraph; repoPath: string }> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-route-handler-edge-'));
  const files = options.files ?? { [CONTROLLER]: HANDLER_SOURCE };
  for (const [filePath, contents] of Object.entries(files)) {
    await fs.mkdir(path.join(repoPath, path.dirname(filePath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, filePath), contents);
  }

  const graph = createKnowledgeGraph();
  if (options.handlerNode) {
    graph.addNode({
      id: options.handlerNode.id,
      label: options.handlerNode.label,
      properties: {
        name: 'createOrder',
        filePath: options.handlerNode.filePath,
        startLine: options.handlerNode.lines?.[0] ?? 0,
        endLine: options.handlerNode.lines?.[1] ?? 2,
      },
    });
  }

  const parseOutput = {
    allPaths: Object.keys(files),
    allFetchCalls: [],
    allFetchWrapperDefs: [],
    allExtractedRoutes: options.extractedRoutes ?? [],
    allDecoratorRoutes: options.decoratorRoutes ?? [],
    routeHandlerSymbols: options.routeHandlerSymbols,
  } as unknown as ParseOutput;

  try {
    await routesPhase.execute(
      { repoPath, graph, onProgress: () => {}, pipelineStart: Date.now() },
      new Map([['parse', { phaseName: 'parse', output: parseOutput, durationMs: 0 }]]),
    );
    return { graph, repoPath };
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
}

/** A single framework route: `POST /orders`, declared in `CONTROLLER`. */
const frameworkRoute = (filePath = CONTROLLER) => ({
  filePath,
  httpMethod: 'post',
  routePath: '/orders',
  routeName: null,
  controllerName: null,
  methodName: null,
  middleware: [],
  prefix: null,
  lineNumber: 1,
});

const POST_ORDERS = routeNodeKey('POST', '/orders');
const ROUTE_ID = generateId('Route', POST_ORDERS);

/** `HANDLES_ROUTE` source ids pointing at the route node, de-duplicated. */
const handlesRouteSources = (graph: KnowledgeGraph, routeNodeId = ROUTE_ID): string[] => [
  ...new Set(
    graph.relationships
      .filter((rel) => rel.type === 'HANDLES_ROUTE' && rel.targetId === routeNodeId)
      .map((rel) => rel.sourceId),
  ),
];

describe('routes phase — definition-level HANDLES_ROUTE', () => {
  it.each<NodeLabel>(['Function', 'Method'])(
    'emits both the file-level and the definition-level edge for a live %s handler',
    async (label) => {
      const handlerId = `${label}:${CONTROLLER}:createOrder`;
      const { graph } = await runRoutesPhase({
        handlerNode: { id: handlerId, label, filePath: CONTROLLER },
        routeHandlerSymbols: new Map([[POST_ORDERS, handlerId]]),
        extractedRoutes: [frameworkRoute()],
      });

      expect(graph.getNode(ROUTE_ID)?.properties.handlerSymbolId).toBe(handlerId);
      expect(handlesRouteSources(graph).sort()).toEqual(
        [generateId('File', CONTROLLER), handlerId].sort(),
      );
    },
  );

  it('falls back to file-level attribution when the handler id has no node in the graph', async () => {
    // Resolution claimed a symbol the graph does not hold. The stamp is the
    // extractor's fast path and the edge would source on an absent node, so
    // neither may be emitted.
    const { graph } = await runRoutesPhase({
      routeHandlerSymbols: new Map([[POST_ORDERS, `Method:${CONTROLLER}:ghost`]]),
      extractedRoutes: [frameworkRoute()],
    });

    const route = graph.getNode(ROUTE_ID);
    expect(route, 'the route itself must survive a dangling handler id').toBeTruthy();
    expect(route?.properties).not.toHaveProperty('handlerSymbolId');
    expect(handlesRouteSources(graph)).toEqual([generateId('File', CONTROLLER)]);
  });

  it('resolves the data-route-table handler path from the graph, and falls back when it dangles', async () => {
    const routeKey = routeNodeKey('GET', '/orders');
    const routeNodeId = generateId('Route', routeKey);
    const handlerId = `Function:${HANDLER_FILE}:createOrder`;
    const dataRoute = {
      filePath: TABLE_FILE,
      routePath: '/orders',
      httpMethod: 'GET',
      decoratorName: 'data-route-table',
      source: DATA_ROUTE_TABLE_SOURCE,
      lineNumber: 1,
      handlerName: 'createOrder',
    };
    const files = {
      [TABLE_FILE]: `export const routes = [{ path: '/orders', method: 'GET', handler: createOrder }];\n`,
      [HANDLER_FILE]: HANDLER_SOURCE,
    };

    const resolved = await runRoutesPhase({
      files,
      handlerNode: { id: handlerId, label: 'Function', filePath: HANDLER_FILE },
      routeHandlerSymbols: new Map([[routeKey, handlerId]]),
      decoratorRoutes: [dataRoute],
    });
    const resolvedRoute = resolved.graph.getNode(routeNodeId);
    expect(resolvedRoute?.properties.filePath).toBe(HANDLER_FILE);
    expect(resolvedRoute?.properties.handlerSymbolId).toBe(handlerId);
    expect(handlesRouteSources(resolved.graph, routeNodeId).sort()).toEqual(
      [generateId('File', HANDLER_FILE), handlerId].sort(),
    );

    const dangling = await runRoutesPhase({
      files,
      routeHandlerSymbols: new Map([[routeKey, handlerId]]),
      decoratorRoutes: [dataRoute],
    });
    const danglingRoute = dangling.graph.getNode(routeNodeId);
    // No handler node to read a path from, so the declaring file stands in.
    expect(danglingRoute?.properties.filePath).toBe(TABLE_FILE);
    expect(danglingRoute?.properties).not.toHaveProperty('handlerSymbolId');
    expect(handlesRouteSources(dangling.graph, routeNodeId)).toEqual([
      generateId('File', TABLE_FILE),
    ]);
  });
});

describe('routes phase — response shape of a route inherited from another file', () => {
  const BASE = 'src/shared/crud.controller.ts';
  const TAGS = 'src/tags/tags.controller.ts';
  const SUMMARY = ['summary(@Res() res) {', '    res.json({ items: [], total: 0 });', '  }'].join(
    '\n',
  );
  const FIRST = 'first(@Res() res) { res.json({ firstKey: 1 }); }';
  const SECOND = 'second(@Res() res) { res.json({ secondKey: 2 }); }';
  const BASE_SOURCE = [
    'export abstract class ReadOnlyController {',
    "  @Get('summary')",
    `  ${SUMMARY}`,
    '',
    // Two handlers on one line: the line holds the payloads of both.
    `  @Get('first') ${FIRST} @Get('second') ${SECOND}`,
    '}',
    '',
  ].join('\n');
  const TAGS_SOURCE = [
    "@Controller('tags')",
    'export class TagsController extends ReadOnlyController {',
    "  @Get('popular')",
    '  popular(@Res() res) {',
    '    res.json({ tags: [], days: 7 });',
    '  }',
    '}',
    '',
  ].join('\n');
  const files = { [BASE]: BASE_SOURCE, [TAGS]: TAGS_SOURCE };

  /** The range `snippet` covers in the base file: lines from 1, columns from 0. */
  const rangeOf = (snippet: string) => {
    const before = BASE_SOURCE.slice(0, BASE_SOURCE.indexOf(snippet)).split('\n');
    const inside = snippet.split('\n');
    const startCol = before[before.length - 1].length;
    return {
      startLine: before.length,
      startCol,
      endLine: before.length + inside.length - 1,
      endCol: (inside.length === 1 ? startCol : 0) + inside[inside.length - 1].length,
    };
  };
  // What `resolveNestInheritedRoutes` emits: the route is the controller's,
  // the handler is a method of the base file.
  const inherited = (handlerName: string, snippet: string) => ({
    filePath: TAGS,
    routePath: handlerName,
    httpMethod: 'GET',
    decoratorName: 'Get',
    lineNumber: 2,
    prefix: 'tags',
    handlerName,
    handlerFilePath: BASE,
    handlerRange: rangeOf(snippet),
  });
  const routeId = (handlerName: string): string =>
    generateId('Route', routeNodeKey('GET', `/tags/${handlerName}`));

  it('reads the keys within the range of the base method and keeps the route in the controller file', async () => {
    const summaryId = `Method:${BASE}:ReadOnlyController.summary`;
    const { graph } = await runRoutesPhase({
      files,
      handlerNode: { id: summaryId, label: 'Method', filePath: BASE, lines: [2, 4] },
      routeHandlerSymbols: new Map([[routeNodeKey('GET', '/tags/summary'), summaryId]]),
      decoratorRoutes: [inherited('summary', SUMMARY)],
    });

    const route = graph.getNode(routeId('summary'));
    expect(route?.properties.responseKeys).toEqual(['items', 'total']);
    expect(route?.properties.filePath).toBe(TAGS);
    expect(handlesRouteSources(graph, routeId('summary')).sort()).toEqual(
      [generateId('File', TAGS), summaryId].sort(),
    );
  });

  it('reads each controller and declaring file once for multiple inherited routes', async () => {
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      const { repoPath } = await runRoutesPhase({
        files,
        routeHandlerSymbols: new Map(),
        decoratorRoutes: [inherited('first', FIRST), inherited('second', SECOND)],
      });
      const paths = readFile.mock.calls.map(([file]) => file);
      for (const file of [BASE, TAGS]) {
        expect(
          paths.filter((input) => input === path.join(repoPath, file)),
          file,
        ).toHaveLength(1);
      }
    } finally {
      readFile.mockRestore();
    }
  });

  it('gives each of two handlers on one line the keys of its own body', async () => {
    // No symbol is resolved here: the range alone says where each body is.
    const { graph } = await runRoutesPhase({
      files,
      routeHandlerSymbols: new Map(),
      decoratorRoutes: [inherited('first', FIRST), inherited('second', SECOND)],
    });

    expect({
      first: graph.getNode(routeId('first'))?.properties.responseKeys,
      second: graph.getNode(routeId('second'))?.properties.responseKeys,
    }).toEqual({ first: ['firstKey'], second: ['secondKey'] });
  });

  it('records no response shape when the file of the base method cannot be read', async () => {
    // The controller's file answers its own route with other keys. Borrowed
    // for the inherited route, they would describe a handler that is not its.
    const { graph } = await runRoutesPhase({
      files: { [TAGS]: TAGS_SOURCE },
      routeHandlerSymbols: new Map(),
      decoratorRoutes: [inherited('summary', SUMMARY)],
    });

    const route = graph.getNode(routeId('summary'));
    expect(route?.properties.filePath).toBe(TAGS);
    expect(route?.properties).not.toHaveProperty('responseKeys');
  });
});
