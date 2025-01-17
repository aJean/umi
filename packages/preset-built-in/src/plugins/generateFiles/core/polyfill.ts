import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { IApi } from '@umijs/types';

/**
 * @file 能不能直接用 @babel/polyfill ??
 */

export default (api: IApi) => {
  api.describe({
    key: 'polyfill',
    config: {
      schema(joi) {
        return joi.object().keys({
          imports: joi.array().items(joi.string()).required().unique(),
        });
      },
    },
    enableBy: () => {
      return process.env.BABEL_POLYFILL !== 'none';
    },
  });

  api.addPolyfillImports(() => [{ source: './core/polyfill' }]);

  api.onGenerateFiles(() => {
    const polyfill = api.config.polyfill;

    api.writeTmpFile({
      content: api.utils.Mustache.render(
        readFileSync(join(__dirname, 'polyfill.tpl'), 'utf-8'),
        {
          imports: polyfill?.imports ? polyfill.imports : [],
        },
      ),
      path: 'core/polyfill.ts',
    });
  });

  api.chainWebpack((memo) => {
    memo.resolve.alias.set(
      'regenerator-runtime',
      dirname(require.resolve('regenerator-runtime/package')),
    );
    return memo;
  });
};
