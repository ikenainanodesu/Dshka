#!/usr/bin/env node
/**
 * `dsh-add` — install a DeepSeek Harness plugin by name.
 *
 * The harness CLI already installs plugins (`dsh plugin --profile <name> add
 * <spec>`), but it installs by *spec*: a package name, a git URL or a path. The
 * community registry keys plugins by a human *name* that is not unique, so
 * "install by name" is a resolution problem, not an installation problem.
 * This command resolves the name, refuses to guess when the evidence is thin,
 * and then hands the spec to the official CLI.
 *
 * @module dsh-add/cli
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRegistry, REGISTRY_URL } from './registry.mjs';
import { decide, describe, normalizeName, resolveQuery, specOf } from './match.mjs';
import {
  addAllowBuild,
  blockedBuildKey,
  chooseProfile,
  diffProfile,
  listProfiles,
  readProfile,
  resolveInstalledName,
  runInstall
} from './install.mjs';
import { join } from 'node:path';

const NAME = 'dsh-add';

/**
 * Print usage.
 * @param locale - `zh` prints the Chinese help text.
 */
function usage(locale) {
  const zh = locale === 'zh';
  const lines = zh
    ? [
        `${NAME} — 按名字安装 DeepSeek Harness 插件`,
        '',
        '用法:',
        `  ${NAME} <名字>                解析并安装（重名时若证据不足会询问）`,
        `  ${NAME} search <关键词>       搜索插件`,
        `  ${NAME} info <名字>           查看候选与安装命令，不安装`,
        `  ${NAME} list                  列出各 profile 已安装的插件`,
        '',
        '选项:',
        '  --profile <名字>   安装到指定 profile（默认自动选择并说明理由）',
        '  --owner <作者>     用作者消歧，如 --owner kenz1117',
        '  --spec <spec>      跳过名字解析，直接安装该 spec（本地路径 / git / npm 名）',
        '  --dry-run          只打印将要执行的命令',
        '  --allow-build      构建脚本被 pnpm 拦住时，自动写入 allowBuilds 并重试',
        '  --refresh          忽略缓存，重新拉取插件注册表',
        '  --json             机器可读输出',
        '  -h, --help         显示帮助',
        '  -V, --version      显示版本',
        '',
        '示例:',
        `  ${NAME} dsh-engram                 # 唯一匹配，直接装`,
        `  ${NAME} dsh-memory --owner FuRongJun-1999`,
        `  ${NAME} --spec ./my-plugin         # 本地开发中的插件`,
        '',
        `注册表: ${REGISTRY_URL}`
      ]
    : [
        `${NAME} — install a DeepSeek Harness plugin by name`,
        '',
        'Usage:',
        `  ${NAME} <name>                resolve and install (asks when the evidence is thin)`,
        `  ${NAME} search <keyword>      search the registry`,
        `  ${NAME} info <name>           show candidates and the install command, install nothing`,
        `  ${NAME} list                  list plugins installed in every profile`,
        '',
        'Options:',
        '  --profile <name>   install into this profile (default: chosen, and said why)',
        '  --owner <owner>    disambiguate by author, e.g. --owner kenz1117',
        '  --spec <spec>      skip name resolution and install this spec (path / git / npm name)',
        '  --dry-run          print the command without running it',
        '  --allow-build      if pnpm blocks a build script, add the allowBuilds key and retry',
        '  --refresh          ignore the cache and refetch the registry',
        '  --json             machine-readable output',
        '  -h, --help         show this help',
        '  -V, --version      show the version',
        '',
        'Examples:',
        `  ${NAME} dsh-engram                 # sole match, installs directly`,
        `  ${NAME} dsh-memory --owner FuRongJun-1999`,
        `  ${NAME} --spec ./my-plugin         # a plugin still in development`,
        '',
        `Registry: ${REGISTRY_URL}`
      ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** @returns the package version. */
function version() {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return manifest.version ?? '0.0.0';
}

/**
 * Pick the output language: `$DSH_ADD_LANG`, then `$LANG`/`$LC_ALL`, else English.
 * @param env - environment mapping.
 * @returns `zh` or `en`.
 */
function localeOf(env) {
  const explicit = (env.DSH_ADD_LANG ?? '').toLowerCase();
  if (explicit.startsWith('zh')) return 'zh';
  if (explicit.startsWith('en')) return 'en';
  const system = `${env.LC_ALL ?? ''}${env.LANG ?? ''}`.toLowerCase();
  return system.includes('zh') ? 'zh' : 'en';
}

/**
 * Render a candidate as one line.
 * @param candidate - a matched candidate.
 * @param index - 1-based position, or 0 to omit numbering.
 * @param locale - output language.
 * @returns the formatted line.
 */
function candidateLine(candidate, index, locale) {
  const plugin = candidate.plugin;
  const label = `${plugin.owner}/${normalizeName(plugin.name)}`;
  const stats = [
    plugin.downloads === null || plugin.downloads === undefined ? undefined : `${plugin.downloads}↓`,
    plugin.stars === null || plugin.stars === undefined ? undefined : `${plugin.stars}★`,
    plugin.version ? `v${plugin.version}` : undefined
  ].filter(Boolean);
  const prefix = index > 0 ? `${String(index).padStart(2)}. ` : '    ';
  const suffix = stats.length > 0 ? `  (${stats.join(', ')})` : '';
  return `${prefix}${label}${suffix}\n      ${specOf(plugin)}\n      ${describe(plugin, locale)}`;
}

/**
 * Ask the user to choose among ambiguous candidates.
 * @param candidates - ranked candidates, best first.
 * @param query - what the user typed.
 * @param locale - output language.
 * @returns the chosen candidate, or undefined when not interactive.
 */
async function askWhich(candidates, query, locale) {
  if (!process.stdin.isTTY) return undefined;
  const shortlist = candidates.slice(0, 9);
  process.stdout.write(
    (locale === 'zh'
      ? `\n「${query}」有 ${candidates.length} 个匹配，证据不足以替你决定。请选择：\n\n`
      : `\n"${query}" has ${candidates.length} matches; the evidence is not decisive. Choose one:\n\n`)
  );
  process.stdout.write(`${shortlist.map((candidate, index) => candidateLine(candidate, index + 1, locale)).join('\n')}\n\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(locale === 'zh' ? '编号（回车取消）: ' : 'Number (Enter to cancel): ')).trim();
    if (answer === '') return undefined;
    const picked = Number.parseInt(answer, 10);
    if (!Number.isInteger(picked) || picked < 1 || picked > shortlist.length) return undefined;
    return shortlist[picked - 1];
  } finally {
    prompt.close();
  }
}

/**
 * Narrow ranked candidates by author.
 * @param candidates - ranked candidates.
 * @param owner - the author to keep.
 * @returns filtered candidates.
 */
function byOwner(candidates, owner) {
  const wanted = owner.toLowerCase();
  return candidates.filter((candidate) => String(candidate.plugin.owner ?? '').toLowerCase() === wanted);
}

/**
 * Report candidates plus the command that would run, then exit.
 * @param ranked - resolved candidates.
 * @param locale - output language.
 */
function printInfo(ranked, locale) {
  const pool = [...ranked.exact, ...ranked.fuzzy];
  if (pool.length === 0) {
    process.stdout.write(locale === 'zh' ? '没有匹配的插件。\n' : 'No matching plugin.\n');
    return;
  }
  if (ranked.exact.length > 0) {
    process.stdout.write((locale === 'zh' ? '精确匹配：\n' : 'Exact matches:\n') + '\n');
    process.stdout.write(`${ranked.exact.map((candidate, index) => candidateLine(candidate, index + 1, locale)).join('\n')}\n`);
  }
  if (ranked.fuzzy.length > 0) {
    process.stdout.write(`\n${locale === 'zh' ? '相近匹配：' : 'Closer matches:'}\n\n`);
    process.stdout.write(`${ranked.fuzzy.map((candidate, index) => candidateLine(candidate, index + 1, locale)).join('\n')}\n`);
  }
}

/**
 * `list`: show installed plugins per profile.
 * @param env - environment mapping.
 * @param locale - output language.
 * @param asJson - emit JSON.
 */
function printInstalled(env, locale, asJson) {
  const profiles = listProfiles(env);
  if (profiles.length === 0) {
    process.stdout.write(locale === 'zh' ? '还没有已初始化的 profile。\n' : 'No initialized profile yet.\n');
    return;
  }
  const rows = profiles.map((profile) => {
    const manifest = readProfile(profile, env)?.manifest ?? {};
    const dependencies = Object.keys(manifest.dependencies ?? {});
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    return { profile, dependencies, bundles };
  });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(`\n${row.profile}  (${row.dependencies.length} deps, ${row.bundles.length} bundles)\n`);
    if (row.dependencies.length === 0) {
      process.stdout.write(locale === 'zh' ? '  （无第三方插件）\n' : '  (no third-party plugins)\n');
      continue;
    }
    for (const name of row.dependencies) {
      const isBundle = row.bundles.includes(name);
      process.stdout.write(`  ${isBundle ? '*' : ' '} ${name}${isBundle ? '' : locale === 'zh' ? '  (未激活：非 bundle)' : '  (not activated: no dsh.bundle)'}\n`);
    }
  }
  process.stdout.write(locale === 'zh' ? '\n* = 作为 profile 层激活\n' : '\n* = active as a profile layer\n');
}

/**
 * `search`: list plugins matching a keyword.
 * @param plugins - registry entries.
 * @param keyword - search term.
 * @param locale - output language.
 * @param asJson - emit JSON.
 */
function printSearch(plugins, keyword, locale, asJson) {
  const wanted = normalizeName(keyword);
  const hits = plugins
    .filter((plugin) => specOf(plugin))
    .filter((plugin) => {
      const haystack = `${plugin.name} ${plugin.npm ?? ''} ${plugin.owner ?? ''} ${describe(plugin)}`.toLowerCase();
      return haystack.includes(wanted);
    })
    .sort((left, right) => (right.downloads ?? -1) - (left.downloads ?? -1));
  if (asJson) {
    process.stdout.write(`${JSON.stringify(hits.slice(0, 50), null, 2)}\n`);
    return;
  }
  if (hits.length === 0) {
    process.stdout.write(locale === 'zh' ? `没有找到包含「${keyword}」的插件。\n` : `No plugin matches "${keyword}".\n`);
    return;
  }
  const shown = hits.slice(0, 20);
  process.stdout.write(
    (locale === 'zh' ? `匹配「${keyword}」的插件 ${hits.length} 个，按下载量排序：\n\n` : `${hits.length} plugins match "${keyword}", by downloads:\n\n`)
  );
  process.stdout.write(`${shown.map((plugin, index) => candidateLine({ plugin, exact: true }, index + 1, locale)).join('\n')}\n`);
  if (hits.length > shown.length) {
    process.stdout.write(locale === 'zh' ? `\n（仅显示前 ${shown.length} 个）\n` : `\n(only the first ${shown.length} are shown)\n`);
  }
}

/**
 * Run the command.
 * @returns the process exit code.
 */
async function main() {
  const locale = localeOf(process.env);
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      profile: { type: 'string' },
      owner: { type: 'string' },
      spec: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'allow-build': { type: 'boolean' },
      refresh: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' }
    },
    allowPositionals: true,
    strict: false
  });

  if (values.help === true) {
    usage(locale);
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const asJson = values.json === true;
  const [first, ...rest] = positionals;
  const command = ['search', 'info', 'list'].includes(first) ? first : 'add';
  const subject = command === 'add' ? [first, ...rest].filter(Boolean).join(' ') : rest.join(' ');
  /** Registry plugins, loaded only when a name has to be resolved. */
  const registry = {};

  if (command === 'list') {
    printInstalled(process.env, locale, asJson);
    return 0;
  }

  // ---- add -----------------------------------------------------------------
  const explicitSpec = typeof values.spec === 'string' && values.spec !== '' ? values.spec : undefined;

  // The registry is only needed to turn a name into a spec. `--spec` names the
  // spec directly, so that path never pays for the download.
  if (explicitSpec === undefined) {
    const { document, source, stale } = await loadRegistry({
      refresh: values.refresh === true,
      env: process.env,
      log: (message) => process.stderr.write(`${message}\n`)
    });
    const plugins = document.plugins;
    if (!asJson) {
      const age = stale ? (locale === 'zh' ? '（缓存已过期）' : ' (stale)') : '';
      process.stderr.write(
        locale === 'zh'
          ? `注册表: ${plugins.length} 个插件，来源 ${source === 'cache' ? '本地缓存' : '网络'}${age}\n`
          : `Registry: ${plugins.length} plugins, from ${source === 'cache' ? 'cache' : 'network'}${age}\n`
      );
    }

    if (command === 'search') {
      if (!subject) {
        process.stderr.write(locale === 'zh' ? `${NAME}: search 需要一个关键词\n` : `${NAME}: search needs a keyword\n`);
        return 2;
      }
      printSearch(plugins, subject, locale, asJson);
      return 0;
    }

    if (command === 'info') {
      if (!subject) {
        process.stderr.write(locale === 'zh' ? `${NAME}: info 需要一个名字\n` : `${NAME}: info needs a name\n`);
        return 2;
      }
      printInfo(resolveQuery(plugins, subject), locale);
      return 0;
    }
    registry.plugins = plugins;
  }

  if (command === 'search' || command === 'info') {
    process.stderr.write(
      locale === 'zh' ? `${NAME}: ${command} 需要一个关键词\n` : `${NAME}: ${command} needs a keyword\n`
    );
    return 2;
  }

  let spec = explicitSpec;
  let plugin;

  if (!spec) {
    if (!subject) {
      usage(locale);
      return 2;
    }
    const ranked = resolveQuery(registry.plugins, subject);
    let pool = ranked;
    if (typeof values.owner === 'string' && values.owner !== '') {
      const narrowed = {
        exact: byOwner(ranked.exact, values.owner),
        fuzzy: byOwner(ranked.fuzzy, values.owner),
        query: ranked.query
      };
      if (narrowed.exact.length + narrowed.fuzzy.length === 0) {
        process.stderr.write(
          locale === 'zh'
            ? `${NAME}: 没有作者为 ${values.owner} 的匹配项\n`
            : `${NAME}: no match from owner ${values.owner}\n`
        );
        return 1;
      }
      pool = narrowed;
    }

    const verdict = decide(pool);
    if (!verdict.decisive) {
      const candidates = pool.exact.length > 0 ? pool.exact : pool.fuzzy;
      if (candidates.length === 0) {
        process.stderr.write(
          locale === 'zh'
            ? `${NAME}: 注册表里没有「${subject}」。用 \`${NAME} search <关键词>\` 找找。\n`
            : `${NAME}: no registry entry for "${subject}". Try \`${NAME} search <keyword>\`.\n`
        );
        return 1;
      }
      const chosen = await askWhich(candidates, subject, locale);
      if (!chosen) {
        process.stderr.write(
          locale === 'zh'
            ? `${NAME}: 未选择。原因：${verdict.reason}。可用 --owner <作者> 或完整包名重试。\n`
            : `${NAME}: nothing chosen. Reason: ${verdict.reason}. Retry with --owner <owner> or the full package name.\n`
        );
        return 1;
      }
      plugin = chosen.plugin;
    } else {
      plugin = verdict.winner.plugin;
    }
    spec = specOf(plugin);
    if (!spec) {
      process.stderr.write(`${NAME}: registry entry ${plugin.name} declares no install command\n`);
      return 1;
    }
  }

  const { profile, reason } = chooseProfile({ explicit: values.profile, env: process.env });
  const profileDir = readProfile(profile, process.env)?.dir;
  const before = readProfile(profile, process.env)?.manifest;
  const baseline = new Set(Object.keys(before?.dependencies ?? {}));

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ spec, profile, profileReason: reason, plugin: plugin ?? null, dryRun: values['dry-run'] === true }, null, 2)}\n`
    );
  } else {
    const title = plugin ? `${normalizeName(plugin.name)}  (${plugin.owner})` : spec;
    process.stdout.write(
      locale === 'zh'
        ? `\n选中: ${title}\nprofile: ${profile}（${reason}）\n命令: dsh plugin --profile ${profile} add ${spec}\n\n`
        : `\nSelected: ${title}\nProfile: ${profile} (${reason})\nCommand: dsh plugin --profile ${profile} add ${spec}\n\n`
    );
  }

  if (values['dry-run'] === true) return 0;

  if (before && resolveInstalledName(spec, before, undefined, new Set()) !== undefined) {
    process.stderr.write(
      locale === 'zh'
        ? `${NAME}: 该插件已装在 ${profile}。更新用 \`dsh plugin --profile ${profile} update\`，移除用 \`... remove <包名>\`。\n`
        : `${NAME}: already installed in ${profile}. Update with \`dsh plugin --profile ${profile} update\`, remove with \`... remove <package>\`.\n`
    );
    return 0;
  }

  const forward = (text) => process.stdout.write(text);
  const allowBuild = values['allow-build'] === true;
  let attempt = runInstall({ profile, spec, log: forward });
  let retried = false;

  if (attempt.status !== 0 && !attempt.captured) {
    // The sandbox refused a piped spawn, so pnpm's output could not be read.
    // Say what to look for instead of leaving the failure unexplained.
    process.stderr.write(
      locale === 'zh'
        ? `\n${NAME}: 无法捕获 pnpm 输出（本环境的沙箱禁止创建管道），已改为直接继承终端输出。\n  若是 git 插件且 pnpm 报 allowBuilds，请加 --allow-build 重试。\n`
        : `\n${NAME}: could not capture pnpm's output (this sandbox forbids creating pipes); it ran with the terminal attached instead.\n  If it was a git plugin and pnpm reported allowBuilds, re-run with --allow-build.\n`
    );
  }

  if (attempt.status !== 0) {
    const key = blockedBuildKey(attempt.output);
    if (key !== undefined) {
      const workspaceFile = join(readProfile(profile, process.env)?.dir ?? '', 'pnpm-workspace.yaml');
      const suggestion = allowBuild
        ? locale === 'zh'
          ? `已按 --allow-build 写入 ${workspaceFile}`
          : `writing it to ${workspaceFile} because of --allow-build`
        : locale === 'zh'
          ? `加 --allow-build 可自动写入 ${workspaceFile} 并重试`
          : `pass --allow-build to write it to ${workspaceFile} and retry automatically`;
      process.stderr.write(
        locale === 'zh'
          ? `\n${NAME}: pnpm 拦住了构建脚本，需要允许键:\n  ${key}\n  ${suggestion}\n`
          : `\n${NAME}: pnpm blocked a build script; the allowlist key is:\n  ${key}\n  ${suggestion}\n`
      );
      if (allowBuild) {
        const applied = addAllowBuild(workspaceFile, key);
        process.stderr.write(`${NAME}: allowBuilds — ${applied.reason}\n`);
        if (applied.changed) {
          attempt = runInstall({ profile, spec, log: forward });
          retried = true;
        }
      }
    }
  }

  if (attempt.status !== 0) {
    process.stderr.write(
      locale === 'zh'
        ? `\n${NAME}: 安装失败（dsh 退出码 ${attempt.status}）。上面的 pnpm 输出就是原因。\n`
        : `\n${NAME}: install failed (dsh exited ${attempt.status}). The pnpm output above is the reason.\n`
    );
    return attempt.status;
  }

  const after = readProfile(profile, process.env)?.manifest;
  const diff = diffProfile(before, after);
  const installedName = resolveInstalledName(spec, after, profileDir, baseline);

  if (installedName === undefined && diff.addedDependencies.length === 0) {
    process.stderr.write(
      locale === 'zh'
        ? `\n${NAME}: 警告 — dsh 退出码 0，但 ${profile} 的依赖没有变化，安装可能没有生效。请检查上面的输出。\n`
        : `\n${NAME}: warning — dsh exited 0 but ${profile}'s dependencies did not change; the install may not have taken effect. Check the output above.\n`
    );
    return 1;
  }

  if (!asJson) {
    const activated = installedName !== undefined && (after?.dsh?.profile?.bundles ?? []).includes(installedName);
    const lines = [
      '',
      locale === 'zh' ? `已安装: ${installedName ?? diff.addedDependencies.join(', ')}` : `Installed: ${installedName ?? diff.addedDependencies.join(', ')}`,
      activated
        ? locale === 'zh'
          ? `已作为 profile 层激活（dsh.profile.bundles）。重启 dsh 后生效。`
          : `Activated as a profile layer (dsh.profile.bundles). Restart dsh for it to load.`
        : locale === 'zh'
          ? `注意：该包没有声明 dsh.bundle，只作为普通依赖安装，不会成为 profile 层。`
          : `Note: the package declares no dsh.bundle, so it is a plain dependency and not a profile layer.`
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

process.exitCode = await main();
