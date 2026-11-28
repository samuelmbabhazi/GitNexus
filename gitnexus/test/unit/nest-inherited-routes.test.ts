/**
 * NestJS routes inherited from a base class in ANOTHER file.
 *
 * `nest-decorator-routes.test.ts` pins what one file yields on its own. This
 * suite pins the join: per-file facts from `extractNestInheritanceFacts`,
 * resolved together by `resolveNestInheritedRoutes`.
 *
 * Where a case describes code NestJS can run, the expectation was checked
 * against a running NestJS 12.5.0 application: the listed URLs answer and the
 * absent ones return 404. The remaining cases — an import nothing resolves, two
 * candidates for one name, files that extend each other, a class the grammar
 * does not parse — pin what the join does with input it cannot prove.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  extractNestInheritanceFacts,
  extractNestRoutes,
} from '../../src/core/ingestion/route-extractors/nest.js';
import { resolveNestInheritedRoutes } from '../../src/core/ingestion/route-extractors/nest-inherited-routes.js';
import { normalizeExtractedRoutePath } from '../../src/core/ingestion/route-extractors/route-path.js';

type Sources = Record<string, string>;

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

function parse(filePath: string, source: string) {
  const isJs = filePath.endsWith('.js');
  const tree = (isJs ? jsParser : tsParser).parse(source);
  const parsed = extractParsedFile(
    isJs ? javascriptProvider : typescriptProvider,
    source,
    filePath,
    undefined,
    tree,
  );
  if (!parsed) throw new Error(`no parsed file for ${filePath}`);
  return { tree, parsedImports: parsed.parsedImports };
}

function factsOf(filePath: string, source: string) {
  const { tree, parsedImports } = parse(filePath, source);
  return extractNestInheritanceFacts(tree, filePath, parsedImports);
}

/** Relative specifiers only, as a file, a `.ts`/`.js` file or a directory index. */
const resolverFor =
  (sources: Sources) =>
  (fromFile: string, specifier: string): string[] => {
    if (!specifier.startsWith('.')) return [];
    const base = path.posix.join(path.posix.dirname(fromFile), specifier);
    return Object.keys(sources).filter((file) =>
      [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`].includes(file),
    );
  };

function inherited(sources: Sources, resolveImportTargets = resolverFor(sources)) {
  const files = Object.entries(sources).flatMap(([filePath, source]) => {
    const facts = factsOf(filePath, source);
    return facts ? [{ filePath, facts }] : [];
  });
  return resolveNestInheritedRoutes(files, resolveImportTargets);
}

const format = (routes: ReturnType<typeof inherited>) =>
  routes.map(
    (route) =>
      `${route.httpMethod} ${normalizeExtractedRoutePath(route.routePath, route.prefix ?? null)}`,
  );

/** The routes of other files that each controller inherits. */
const inheritedUrls = (sources: Sources) => format(inherited(sources));

/** What the graph ends up with: each file's own routes, then the inherited ones. */
const allUrls = (sources: Sources) => [
  ...Object.entries(sources).flatMap(([filePath, source]) =>
    format(extractNestRoutes(parse(filePath, source).tree, filePath)),
  ),
  ...inheritedUrls(sources),
];

const CRUD = `
  import { Get, Post } from '@nestjs/common';

  export abstract class Crud<T> {
    @Get()
    findAll(): T[] { return []; }

    @Get(':id')
    findOne() {}

    @Post()
    create() {}
  }
`;

/** A controller with an empty body that extends `heritage`, after `imports`. */
const controller = (imports: string, heritage: string, body = '') => `
  import { Controller, Get, Post } from '@nestjs/common';
  ${imports}

  @Controller('x')
  export class XController extends ${heritage} {
    ${body}
  }
`;

describe('NestJS routes inherited across files', () => {
  it('mounts the routes of an imported base class under the controller prefix', () => {
    const routes = inherited({
      'crud.ts': CRUD,
      'users.controller.ts': `
        import { Controller, Get } from '@nestjs/common';
        import { Crud } from './crud';

        @Controller('users')
        export class UsersController extends Crud<User> {
          @Get('me')
          me() {}
        }
      `,
      'orgs.controller.ts': `
        import { Controller } from '@nestjs/common';
        import { Crud } from './crud';

        @Controller('orgs')
        export class OrgsController extends Crud<Org> {}
      `,
    });

    expect(format(routes)).toEqual([
      'GET /orgs',
      'POST /orgs',
      'GET /orgs/:id',
      'GET /users',
      'POST /users',
      'GET /users/:id',
    ]);
  });

  it('keeps an inherited route in the controller file and says where its handler is declared', () => {
    // The controller's rows are the ones an incremental write replaces when
    // the controller or its base class changes, so the route is its own. The
    // handler is the base method: `handlerFilePath` sends the name lookup to
    // the file that declares it, where the controller's file has no such name,
    // and `handlerRange` is what that method covers there, lines counted from 1
    // and columns from 0.
    const routes = inherited({
      'crud.ts': CRUD,
      'x.controller.ts': controller("import { Crud } from './crud';", 'Crud<User>'),
    });

    expect(routes).toEqual([
      {
        filePath: 'x.controller.ts',
        routePath: '/',
        httpMethod: 'GET',
        decoratorName: 'Get',
        lineNumber: 6,
        prefix: 'x',
        handlerName: 'findAll',
        handlerFilePath: 'crud.ts',
        handlerRange: { startLine: 6, startCol: 4, endLine: 6, endCol: 33 },
      },
      {
        filePath: 'x.controller.ts',
        routePath: '/',
        httpMethod: 'POST',
        decoratorName: 'Post',
        lineNumber: 6,
        prefix: 'x',
        handlerName: 'create',
        handlerFilePath: 'crud.ts',
        handlerRange: { startLine: 12, startCol: 4, endLine: 12, endCol: 15 },
      },
      {
        filePath: 'x.controller.ts',
        routePath: ':id',
        httpMethod: 'GET',
        decoratorName: 'Get',
        lineNumber: 6,
        prefix: 'x',
        handlerName: 'findOne',
        handlerFilePath: 'crud.ts',
        handlerRange: { startLine: 9, startCol: 4, endLine: 9, endCol: 16 },
      },
    ]);
  });

  it.each([
    {
      label: 'two classes of a file',
      bases: `
        import { Get } from '@nestjs/common';

        export class Alpha {
          @Get('ping')
          ping() {}
        }

        export class Beta {
          @Get('ping')
          ping() {}
        }
      `,
      alpha: 'bases.ts 6:10-6:19 ping',
      beta: 'bases.ts 11:10-11:19 ping',
    },
    {
      label: 'two classes on one line',
      bases: `import { Get } from '@nestjs/common';
export class Alpha { @Get('ping') ping() {} } export class Beta { @Get('ping') ping() {} }`,
      alpha: 'bases.ts 2:34-2:43 ping',
      beta: 'bases.ts 2:79-2:88 ping',
    },
  ])('names the range of the handler when $label declare it', ({ bases, alpha, beta }) => {
    // The file and the name fit two methods. The range is the method's own:
    // it starts below the decorator, and no two methods share one.
    const handlerOf = (base: string) =>
      inherited({
        'bases.ts': bases,
        'x.controller.ts': controller(`import { ${base} } from './bases';`, base),
      }).map(({ handlerFilePath, handlerRange: at, handlerName }) =>
        at === undefined
          ? 'no range'
          : `${handlerFilePath} ${at.startLine}:${at.startCol}-${at.endLine}:${at.endCol} ${handlerName}`,
      );

    expect(handlerOf('Alpha')).toEqual([alpha]);
    expect(handlerOf('Beta')).toEqual([beta]);
  });

  it('names, for each level of a chain, the file of the class that declares the handler', () => {
    const routes = inherited({
      'level-a.ts': `
        import { Get } from '@nestjs/common';
        export class LevelA { @Get('a') a() {} }
      `,
      'level-b.ts': `
        import { Get } from '@nestjs/common';
        import { LevelA } from './level-a';
        class Local extends LevelA { @Get('local') local() {} }
        export class LevelB extends Local { @Get('b') b() {} }
      `,
      'level-c.controller.ts': `
        import { Controller } from '@nestjs/common';
        import { LevelB } from './level-b';

        @Controller('multi')
        export class LevelCController extends LevelB {}
      `,
    });

    expect(
      routes.map((route) => `${route.routePath} ${route.handlerFilePath}:${route.handlerName}`),
    ).toEqual(['a level-a.ts:a', 'b level-b.ts:b', 'local level-b.ts:local']);
  });

  it('follows the chain through several files, the nearest class first', () => {
    expect(
      allUrls({
        'level-a.ts': `
          import { Get } from '@nestjs/common';
          export class LevelA { @Get('a') a() {} }
        `,
        'level-b.ts': `
          import { Get } from '@nestjs/common';
          import { LevelA } from './level-a';
          export class LevelB extends LevelA { @Get('b') b() {} }
        `,
        'level-c.controller.ts': `
          import { Controller, Get } from '@nestjs/common';
          import { LevelB } from './level-b';

          @Controller('multi')
          export class LevelCController extends LevelB { @Get('c') c() {} }
        `,
      }),
    ).toEqual(['GET /multi/c', 'GET /multi/a', 'GET /multi/b']);
  });

  it.each([
    {
      label: 'a default import',
      base: "export default abstract class Base { @Get('ping') ping() {} }",
      imports: "import Base from './base';",
    },
    {
      label: 'a default import of an anonymous class',
      base: "export default class { @Get('ping') ping() {} }",
      imports: "import Base from './base';",
    },
    {
      label: 'an anonymous default with a block comment after export',
      base: "export /* controller base */ default class { @Get('ping') ping() {} }",
      imports: "import Base from './base';",
    },
    {
      label: 'an aliased import',
      base: "export class Named { @Get('ping') ping() {} }",
      imports: "import { Named as Base } from './base';",
    },
    {
      label: 'a class exported below its declaration',
      base: "class Base { @Get('ping') ping() {} }\nexport { Base };",
      imports: "import { Base } from './base';",
    },
    {
      label: 'a class exported under another name',
      base: "class Hidden { @Get('ping') ping() {} }\nexport { Hidden as Base };",
      imports: "import { Base } from './base';",
    },
    {
      label: 'a class exported as default by name',
      base: "class Hidden { @Get('ping') ping() {} }\nexport default Hidden;",
      imports: "import Base from './base';",
    },
  ])('follows $label', ({ base, imports }) => {
    expect(
      inheritedUrls({
        'base.ts': `import { Get } from '@nestjs/common';\n${base}`,
        'x.controller.ts': controller(imports, 'Base'),
      }),
    ).toEqual(['GET /x/ping']);
  });

  it.each([
    { label: 'export *', barrel: "export * from './base';", name: 'Base' },
    { label: 'a named re-export', barrel: "export { Base } from './base';", name: 'Base' },
    {
      label: 'a renaming re-export',
      barrel: "export { Base as Renamed } from './base';",
      name: 'Renamed',
    },
    {
      label: 'a re-export of the default',
      barrel: "export { default as Base } from './default';",
      name: 'Base',
    },
    {
      label: 'a re-export of an anonymous default',
      barrel: "export { default as Base } from './anonymous';",
      name: 'Base',
    },
    {
      label: 'two barrels in a row',
      barrel: "export * from './inner';",
      name: 'Base',
    },
  ])('follows a barrel that uses $label', ({ barrel, name }) => {
    expect(
      inheritedUrls({
        'shared/base.ts': `
          import { Get } from '@nestjs/common';
          export class Base { @Get('ping') ping() {} }
        `,
        'shared/default.ts': `
          import { Get } from '@nestjs/common';
          export default class Base { @Get('ping') ping() {} }
        `,
        'shared/anonymous.ts': `
          import { Get } from '@nestjs/common';
          export default class { @Get('ping') ping() {} }
        `,
        'shared/inner/index.ts': "export * from '../base';",
        'shared/index.ts': barrel,
        'x.controller.ts': controller(`import { ${name} } from './shared';`, name),
      }),
    ).toEqual(['GET /x/ping']);
  });

  it('continues from a same-file base class into the imported one', () => {
    expect(
      allUrls({
        'root.ts': `
          import { Get } from '@nestjs/common';
          export class Root {
            @Get('root') root() {}
            @Get('hidden') hidden() {}
          }
        `,
        'x.controller.ts': `
          import { Controller, Get } from '@nestjs/common';
          import { Root } from './root';

          class Local extends Root {
            @Get('local') local() {}
            hidden() {}
          }

          @Controller('x')
          export class XController extends Local {
            @Get('own') own() {}
          }
        `,
      }),
    ).toEqual(['GET /x/own', 'GET /x/local', 'GET /x/root']);
  });

  it('passes through a class that declares no route of its own', () => {
    expect(
      inheritedUrls({
        'root.ts': `
          import { Get } from '@nestjs/common';
          export class Root { @Get('root') root() {} }
        `,
        'mid.ts': `
          import { Root } from './root';
          export abstract class Mid<T> extends Root {}
        `,
        'x.controller.ts': controller("import { Mid } from './mid';", 'Mid<User>'),
      }),
    ).toEqual(['GET /x/root']);
  });

  it('mounts inherited routes at the root for a controller without a prefix', () => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export class Base {
            @Get() index() {}
            @Get('ping') ping() {}
          }
        `,
        'x.controller.ts': controller("import { Base } from './base';", 'Base').replace(
          "@Controller('x')",
          '@Controller()',
        ),
      }),
    ).toEqual(['GET /', 'GET /ping']);
  });

  it('does not inherit a base handler declared under a computed key', () => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export class Base {
            @Get('computed') [HANDLER]() {}
            @Get('named') named() {}
          }
        `,
        'x.controller.ts': controller("import { Base } from './base';", 'Base'),
      }),
    ).toEqual(['GET /x/named']);
  });

  it('reaches a base class the other file keeps to itself', () => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          class Hidden { @Get('deep') deep() {} }
          export class Base extends Hidden { @Get('top') top() {} }
        `,
        'x.controller.ts': controller("import { Base } from './base';", 'Base'),
      }),
    ).toEqual(['GET /x/deep', 'GET /x/top']);
  });

  it('walks through an anonymous default class as through a named one', () => {
    // `export default class extends Local { … }` has no name: the import of
    // `default` is the only way in. From there it hides `hidden`, adds `mid`
    // and passes the chain on, and its handlers are found in its own file.
    const routes = inherited({
      'root.ts': `
        import { Get } from '@nestjs/common';
        export class Root {
          @Get('root') root() {}
          @Get('hidden') hidden() {}
        }
      `,
      'mid.ts': `
        import { Get } from '@nestjs/common';
        import { Root } from './root';
        class Local extends Root { @Get('local') local() {} }
        export default class extends Local {
          @Get('mid') mid() {}
          hidden() {}
        }
      `,
      'x.controller.ts': controller("import Mid from './mid';", 'Mid'),
    });

    expect(
      routes.map((route) => `${route.routePath} ${route.handlerFilePath}:${route.handlerName}`),
    ).toEqual(['local mid.ts:local', 'mid mid.ts:mid', 'root root.ts:root']);
  });

  it('inherits from a base class that is a controller in its own file', () => {
    const sources = {
      'base.controller.ts': `
        import { Controller, Get } from '@nestjs/common';

        @Controller('base')
        export class BaseController { @Get('ping') ping() {} }
      `,
      'x.controller.ts': controller(
        "import { BaseController } from './base.controller';",
        'BaseController',
      ),
    };

    expect(allUrls(sources)).toEqual(['GET /base/ping', 'GET /x/ping']);
  });

  it.each([
    {
      label: 'redeclared by the controller',
      body: 'list() {}',
      expected: ['GET /x/kept'],
    },
    {
      label: 'redeclared with another route',
      body: "@Post('changed') list() {}",
      expected: ['GET /x/kept'],
    },
    {
      label: 'hidden by an accessor',
      body: 'get list() { return () => 1; }',
      expected: ['GET /x/kept'],
    },
    {
      label: 'beside a field of the same name',
      body: 'list = () => 1;',
      expected: ['GET /x/kept', 'GET /x/list'],
    },
    {
      label: 'beside a static method of the same name',
      body: 'static list() {}',
      expected: ['GET /x/kept', 'GET /x/list'],
    },
  ])('applies the prototype rules to a route $label', ({ body, expected }) => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export class Base {
            @Get('list') list() {}
            @Get('kept') kept() {}
          }
        `,
        'x.controller.ts': controller("import { Base } from './base';", 'Base', body),
      }),
    ).toEqual(expected);
  });

  it('lets a class between the two decide, in whichever file it lives', () => {
    expect(
      inheritedUrls({
        'root.ts': `
          import { Get } from '@nestjs/common';
          export class Root {
            @Get('plain') plain() {}
            @Get('changed') changed() {}
            @Get('kept') kept() {}
          }
        `,
        'mid.ts': `
          import { Get, Post } from '@nestjs/common';
          import { Root } from './root';
          export class Mid extends Root {
            plain() {}
            @Post('moved') changed() {}
            @Get('mid') mid() {}
          }
        `,
        'x.controller.ts': controller("import { Mid } from './mid';", 'Mid'),
      }),
    ).toEqual(['GET /x/kept', 'GET /x/mid', 'POST /x/moved']);
  });

  it('leaves a URL to the handler the controller declares for it', () => {
    // NestJS registers the controller's own handler first, and the first one
    // registered for a verb and URL answers: a request to `/x/same` gets `own`.
    const sources = {
      'base.ts': `
        import { Get } from '@nestjs/common';
        export class Base {
          @Get('same') fromBase() {}
          @Get('other') other() {}
        }
      `,
      'x.controller.ts': controller(
        "import { Base } from './base';",
        'Base',
        "@Get('same') own() {}",
      ),
    };

    expect(inheritedUrls(sources)).toEqual(['GET /x/other']);
    expect(allUrls(sources)).toEqual(['GET /x/same', 'GET /x/other']);
  });

  it('emits the route once for each controller file that mounts the base class', () => {
    const routes = inherited({
      'base.ts': `
        import { Get } from '@nestjs/common';
        export class Base { @Get('ping') ping() {} }
      `,
      'first.controller.ts': controller("import { Base } from './base';", 'Base'),
      'second.controller.ts': controller("import { Base } from './base';", 'Base'),
    });

    expect(routes.map((route) => route.filePath)).toEqual([
      'first.controller.ts',
      'second.controller.ts',
    ]);
    expect(format(routes)).toEqual(['GET /x/ping', 'GET /x/ping']);
  });

  it('stops above a class whose method names cannot all be read', () => {
    expect(
      inheritedUrls({
        'root.ts': `
          import { Get } from '@nestjs/common';
          export class Root { @Get('root') root() {} }
        `,
        'mid.ts': `
          import { Get } from '@nestjs/common';
          import { Root } from './root';
          export class Mid extends Root {
            @Get('mid') mid() {}
            [HANDLER]() {}
          }
        `,
        'x.controller.ts': controller("import { Mid } from './mid';", 'Mid'),
      }),
    ).toEqual(['GET /x/mid']);
  });

  it.each([
    {
      label: 'a namespace import',
      imports: "import * as bases from './base';",
      heritage: 'bases.Base',
    },
    {
      label: 'a type-only import',
      imports: "import type { Base } from './base';",
      heritage: 'Base',
    },
    {
      label: 'a package outside the repository',
      imports: "import { Base } from '@acme/base';",
      heritage: 'Base',
    },
    {
      label: 'a file that does not export the name',
      imports: "import { Missing } from './base';",
      heritage: 'Missing',
    },
    {
      label: 'a mixin call',
      imports: "import { Base } from './base';",
      heritage: 'Mixin(Base)',
    },
    {
      label: 'two imports of one name',
      imports: "import { Base } from './base';\nimport { Base } from './other';",
      heritage: 'Base',
    },
  ])('inherits nothing through $label', ({ imports, heritage }) => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export class Base { @Get('ping') ping() {} }
        `,
        'other.ts': `
          import { Get } from '@nestjs/common';
          export class Base { @Get('pong') pong() {} }
        `,
        'x.controller.ts': controller(imports, heritage),
      }),
    ).toEqual([]);
  });

  it('inherits nothing when the import resolves to two files', () => {
    const sources = {
      'base.ts': `
        import { Get } from '@nestjs/common';
        export class Base { @Get('ping') ping() {} }
      `,
      'x.controller.ts': controller("import { Base } from './base';", 'Base'),
    };

    expect(format(inherited(sources, () => ['base.ts', 'x.controller.ts']))).toEqual([]);
  });

  it('inherits nothing when two star exports provide the name', () => {
    expect(
      inheritedUrls({
        'one.ts': `
          import { Get } from '@nestjs/common';
          export class Base { @Get('one') one() {} }
        `,
        'two.ts': `
          import { Get } from '@nestjs/common';
          export class Base { @Get('two') two() {} }
        `,
        'index.ts': "export * from './one';\nexport * from './two';",
        'x.controller.ts': controller("import { Base } from './index';", 'Base'),
      }),
    ).toEqual([]);
  });

  it('does not take `default` from a star export', () => {
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export default class Base { @Get('ping') ping() {} }
        `,
        'index.ts': "export * from './base';",
        'x.controller.ts': controller("import Base from './index';", 'Base'),
      }),
    ).toEqual([]);
  });

  it('inherits nothing from an anonymous class declared abstract', () => {
    // NestJS serves `GET /x/ping` here. tree-sitter-typescript has no rule for
    // an abstract class without a name and puts an error node where the class
    // would be, so there is nothing to read. The named form is followed above.
    expect(
      inheritedUrls({
        'base.ts': `
          import { Get } from '@nestjs/common';
          export default abstract class { @Get('ping') ping() {} }
        `,
        'x.controller.ts': controller("import Base from './base';", 'Base'),
      }),
    ).toEqual([]);
  });

  it('leaves no controller open when its prefix cannot be read', () => {
    expect(
      factsOf(
        'x.controller.ts',
        `
          import { Controller } from '@nestjs/common';
          import { Base } from './base';

          @Controller(ROUTES.X)
          export class XController extends Base {}
        `,
      )?.controllers,
    ).toEqual([]);
  });

  it('finishes on files whose classes extend each other', () => {
    expect(
      inheritedUrls({
        'a.ts': `
          import { Get } from '@nestjs/common';
          import { B } from './b';
          export class A extends B { @Get('a') a() {} }
        `,
        'b.ts': `
          import { Get } from '@nestjs/common';
          import { A } from './a';
          export class B extends A { @Get('b') b() {} }
        `,
        'x.controller.ts': controller("import { A } from './a';", 'A'),
      }),
    ).toEqual(['GET /x/a', 'GET /x/b']);
  });

  it('finishes on barrels that re-export each other', () => {
    expect(
      inheritedUrls({
        'one/index.ts': "export * from '../two';",
        'two/index.ts': "export * from '../one';",
        'x.controller.ts': controller("import { Base } from './one';", 'Base'),
      }),
    ).toEqual([]);
  });

  it('reads the same shapes under the JavaScript grammar', () => {
    expect(
      inheritedUrls({
        'base.js': `
          import { Get } from '@nestjs/common';
          export class Base {
            @Get('ping')
            ping() {}
          }
        `,
        'x.controller.js': `
          import { Controller } from '@nestjs/common';
          import { Base } from './base';

          @Controller('x')
          export class XController extends Base {}
        `,
      }),
    ).toEqual(['GET /x/ping']);
  });

  it('reads an anonymous default class under the JavaScript grammar', () => {
    expect(
      inheritedUrls({
        'base.js': `
          import { Get } from '@nestjs/common';
          export default class {
            @Get('ping')
            ping() {}
          }
        `,
        'x.controller.js': `
          import { Controller } from '@nestjs/common';
          import Base from './base';

          @Controller('x')
          export class XController extends Base {}
        `,
      }),
    ).toEqual(['GET /x/ping']);
  });

  it.each([
    {
      label: 'a named class',
      base: "export class Base { @Get('ping') ping() {} @Get('hidden') hidden() {} }",
      imports: "import { Base } from './base';",
    },
    {
      label: 'a class without a name either',
      base: "export default class { @Get('ping') ping() {} @Get('hidden') hidden() {} }",
      imports: "import Base from './base';",
    },
  ])('gives a controller without a name the routes of $label', ({ base, imports }) => {
    // `@Controller('x') export default class extends Base { … }` is a class
    // without a name. NestJS serves its own route and the inherited one, and
    // not the handler it redeclares without a decorator.
    const withBase = (controller: string): Sources => ({
      'base.ts': `import { Get } from '@nestjs/common';\n${base}`,
      'x.controller.ts': `import { Controller, Get } from '@nestjs/common';\n${imports}\n${controller}`,
    });
    const body = "extends Base { @Get('own') own() {} hidden() {} }";

    expect(allUrls(withBase(`@Controller('x')\nexport default class ${body}`))).toEqual([
      'GET /x/own',
      'GET /x/ping',
    ]);
    expect(allUrls(withBase(`export default @Controller('x') class ${body}`))).toEqual([
      'GET /x/own',
      'GET /x/ping',
    ]);
  });

  it('reads a controller without a name under the JavaScript grammar', () => {
    expect(
      allUrls({
        'base.js':
          "import { Get } from '@nestjs/common';\nexport class Base { @Get('ping') ping() {} }",
        'x.controller.js':
          "import { Controller } from '@nestjs/common';\nimport { Base } from './base';\n@Controller('x')\nexport default class extends Base {}",
      }),
    ).toEqual(['GET /x/ping']);
  });

  it('does not depend on the order the files are read in', () => {
    const sources: Sources = {
      'crud.ts': CRUD,
      'shared/index.ts': "export * from '../crud';",
      'users.controller.ts': controller("import { Crud } from './shared';", 'Crud'),
      'orgs.controller.ts': controller("import { Crud } from './crud';", 'Crud').replace(
        "@Controller('x')",
        "@Controller('orgs')",
      ),
    };
    const reversed = Object.fromEntries(Object.entries(sources).reverse());

    expect(inherited(reversed)).toEqual(inherited(sources));
    expect(inheritedUrls(sources)).toHaveLength(6);
  });

  describe('facts', () => {
    it('are plain data, so they survive the worker and cache boundary', () => {
      const facts = factsOf(
        'x.controller.ts',
        `
          import { Controller, Get } from '@nestjs/common';
          import { Base } from './base';
          export * from './other';

          class Local extends Base { @Get('local') local() {} }

          @Controller('x')
          export class XController extends Local { @Get('own') own() {} }
        `,
      );

      expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
      expect(facts).toEqual({
        classes: [
          {
            name: 'Local',
            exportedAs: [],
            base: { source: './base', name: 'Base' },
            names: ['local'],
            routes: [
              {
                handlerName: 'local',
                handlerRange: { startLine: 6, startCol: 51, endLine: 6, endCol: 61 },
                httpMethod: 'GET',
                decoratorName: 'Get',
                routePath: 'local',
              },
            ],
          },
          {
            name: 'XController',
            exportedAs: ['XController'],
            base: { local: 'Local' },
            names: ['own'],
            routes: [
              {
                handlerName: 'own',
                handlerRange: { startLine: 9, startCol: 63, endLine: 9, endCol: 71 },
                httpMethod: 'GET',
                decoratorName: 'Get',
                routePath: 'own',
              },
            ],
          },
        ],
        controllers: [
          {
            prefix: 'x',
            lineNumber: 9,
            redeclared: ['own', 'local'],
            claimed: ['GET /x/own', 'GET /x/local'],
            base: { source: './base', name: 'Base' },
          },
        ],
        reexports: [],
        starExports: ['./other'],
      });
    });

    it('record an anonymous default class under its export, without a name', () => {
      expect(
        factsOf(
          'base.ts',
          `
            import { Get } from '@nestjs/common';
            import { Root } from './root';
            export default class extends Root { @Get('ping') ping() {} }
          `,
        ),
      ).toEqual({
        classes: [
          {
            exportedAs: ['default'],
            base: { source: './root', name: 'Root' },
            names: ['ping'],
            routes: [
              {
                handlerName: 'ping',
                handlerRange: { startLine: 4, startCol: 61, endLine: 4, endCol: 70 },
                httpMethod: 'GET',
                decoratorName: 'Get',
                routePath: 'ping',
              },
            ],
          },
        ],
        controllers: [],
        reexports: [],
        starExports: [],
      });
    });

    it('record a controller without a name, open at its imported base', () => {
      expect(
        factsOf(
          'x.controller.ts',
          `
            import { Controller, Get } from '@nestjs/common';
            import { Base } from './base';
            @Controller('x')
            export default class extends Base { @Get('own') own() {} }
          `,
        ),
      ).toEqual({
        classes: [
          {
            exportedAs: ['default'],
            base: { source: './base', name: 'Base' },
            names: ['own'],
            routes: [
              {
                handlerName: 'own',
                handlerRange: { startLine: 5, startCol: 60, endLine: 5, endCol: 68 },
                httpMethod: 'GET',
                decoratorName: 'Get',
                routePath: 'own',
              },
            ],
          },
        ],
        controllers: [
          {
            prefix: 'x',
            lineNumber: 5,
            redeclared: ['own'],
            claimed: ['GET /x/own'],
            base: { source: './base', name: 'Base' },
          },
        ],
        reexports: [],
        starExports: [],
      });
    });

    it.each([
      { label: 'no class and no re-export', source: 'export const answer = 42;' },
      { label: 'a class that extends nothing', source: 'export class Plain { run() {} }' },
      {
        label: 'a class that extends a global',
        source: 'export class Failure extends Error { code() {} }',
      },
      {
        label: 'an anonymous class extending a global',
        source: 'export default class extends Error { code() {} }',
      },
    ])('are absent for a file with $label', ({ source }) => {
      expect(factsOf('plain.ts', source)).toBeUndefined();
    });

    it.each([
      { label: 'an exported class', keyword: 'export class' },
      { label: 'a class that is not exported', keyword: 'class' },
    ])('give $label the line of its name', ({ keyword }) => {
      // The decorator is part of the class node only when nothing exports it.
      const source = [
        "import { Controller } from '@nestjs/common';",
        "import { Base } from './base';",
        "@Controller('x')",
        `${keyword} XController extends Base {}`,
      ].join('\n');
      const { tree, parsedImports } = parse('x.ts', source);

      const lineOf = (lineOffset?: number) =>
        extractNestInheritanceFacts(tree, 'x.ts', parsedImports, lineOffset)?.controllers.map(
          (controller) => controller.lineNumber,
        );

      expect(lineOf()).toEqual([4]);
      // An embedded script block starts further down its file.
      expect(lineOf(20)).toEqual([24]);
    });

    it('count the lines of a handler range from the top of the file', () => {
      const source = [
        "import { Get } from '@nestjs/common';",
        'export class Base {',
        "  @Get('ping')",
        '  ping() {',
        '    return 1;',
        '  }',
        '}',
      ].join('\n');
      const { tree, parsedImports } = parse('base.ts', source);

      const rangesOf = (lineOffset?: number) =>
        extractNestInheritanceFacts(tree, 'base.ts', parsedImports, lineOffset)?.classes.flatMap(
          (cls) => cls.routes.map((route) => route.handlerRange),
        );

      expect(rangesOf()).toEqual([{ startLine: 4, startCol: 2, endLine: 6, endCol: 3 }]);
      // Further down for an embedded script block; the columns do not move.
      expect(rangesOf(20)).toEqual([{ startLine: 24, startCol: 2, endLine: 26, endCol: 3 }]);
    });

    it('record a barrel that declares no class', () => {
      expect(factsOf('index.ts', "export * from './a';\nexport { B as C } from './b';")).toEqual({
        classes: [],
        controllers: [],
        reexports: [{ name: 'C', source: './b', imported: 'B' }],
        starExports: ['./a'],
      });
    });
  });
});
