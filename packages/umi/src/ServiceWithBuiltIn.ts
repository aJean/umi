import { dirname, join } from 'path';
import { IServiceOpts, Service as CoreService } from '@umijs/core';

/**
 * @file 继承 service，在初始化时加载插件集
 */

class Service extends CoreService {
  constructor(opts: IServiceOpts) {
    process.env.UMI_VERSION = require('../package').version;
    process.env.UMI_DIR = dirname(require.resolve('../package'));

    super({
      ...opts,
      presets: [
        require.resolve('@umijs/preset-built-in'),
        ...(opts.presets || []),
      ],
      plugins: [require.resolve('./plugins/umiAlias'), ...(opts.plugins || [])],
    });
  }
}

export { Service };
