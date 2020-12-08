import { IApi, NextFunction, Request, Response } from '@umijs/types';
import { extname, join } from 'path';
import { matchRoutes, RouteConfig } from 'react-router-config';
import { getHtmlGenerator } from '../htmlUtils';

/**
 * @file server 路由中间件，更加可控
 */

const ASSET_EXTNAMES = ['.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg'];

export default ({
  api,
  sharedMap,
}: {
  api: IApi;
  sharedMap: Map<string, string>;
}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    async function sendHtml() {
      // 自己实现 html，不使用 html-webpack-plugin
      const html = getHtmlGenerator({ api });

      let route: RouteConfig = { path: req.path };
      if (api.config.exportStatic) {
        const routes = (await api.getRoutes()) as RouteConfig[];
        const matchedRoutes = matchRoutes(routes, req.path);
        if (matchedRoutes.length) {
          route = matchedRoutes[matchedRoutes.length - 1].route;
        }
      }

      // 使用 bundler 生成的 chunks 构建 html
      const content = await html.getContent({
        route,
        chunks: sharedMap.get('chunks'),
      });
      res.setHeader('Content-Type', 'text/html');
      res.send(content);
    }

    // 同时起到代理路由的作用，请求都渲染 html，可以支持 browser history
    if (req.path === '/favicon.ico') {
      res.sendFile(join(__dirname, 'umi.png'));
    } else if (ASSET_EXTNAMES.includes(extname(req.path))) {
      next();
    } else {
      await sendHtml();
    }
  };
};
