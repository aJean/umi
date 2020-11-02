import { IApi } from '@umijs/types';
import { Route } from '@umijs/core';

/**
 * @file 路由收集，这个插件注册了 getRoutes 方法，在 generateFiles/core/routes.ts 里面使用
 *       感觉比较绕呀，直接去里面写好了，可能是为了 describe 一个配置吧
 */

export default function (api: IApi) {
  api.describe({
    key: 'routes',
    config: {
      schema(joi) {
        return joi.array().items(
          joi
            .object({
              path: joi.string().description('Any valid URL path'),
              component: joi
                .alternatives(joi.string(), joi.function())
                .description(
                  'A React component to render only when the location matches.',
                ),
              wrappers: joi.array().items(joi.string()),
              redirect: joi.string().description('navigate to a new location'),
              exact: joi
                .boolean()
                .description(
                  'When true, the active class/style will only be applied if the location is matched exactly.',
                ),
              routes: joi.array().items(joi.link('...')),
            })
            .unknown(),
        );
      },
      onChange: api.ConfigChangeType.regenerateTmpFiles,
    },
  });

  api.registerMethod({
    name: 'getRoutes',
    async fn() {
      const route = new Route({
        async onPatchRoutesBefore(args: object) {
          await api.applyPlugins({
            key: 'onPatchRoutesBefore',
            type: api.ApplyPluginsType.event,
            args,
          });
        },
        async onPatchRoutes(args: object) {
          await api.applyPlugins({
            key: 'onPatchRoutes',
            type: api.ApplyPluginsType.event,
            args,
          });
        },
        async onPatchRouteBefore(args: object) {
          await api.applyPlugins({
            key: 'onPatchRouteBefore',
            type: api.ApplyPluginsType.event,
            args,
          });
        },
        async onPatchRoute(args: object) {
          await api.applyPlugins({
            key: 'onPatchRoute',
            type: api.ApplyPluginsType.event,
            args,
          });
        },
      });
      return await api.applyPlugins({
        key: 'modifyRoutes',
        type: api.ApplyPluginsType.modify,
        initialValue: await route.getRoutes({
          config: api.config,
          root: api.paths.absPagesPath!,
        }),
      });
    },
  });
}
