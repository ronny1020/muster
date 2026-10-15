/**
 * Every catalog, imported statically so the first render already has its
 * language: the five together are a few dozen kilobytes.
 */
import enUS_common from './locales/en-US/common.json'
import enUS_settings from './locales/en-US/settings.json'
import enUS_launch from './locales/en-US/launch.json'
import enUS_terminal from './locales/en-US/terminal.json'
import enUS_review from './locales/en-US/review.json'
import enUS_workspace from './locales/en-US/workspace.json'
import enUS_chrome from './locales/en-US/chrome.json'
import enGB_common from './locales/en-GB/common.json'
import enGB_settings from './locales/en-GB/settings.json'
import enGB_launch from './locales/en-GB/launch.json'
import enGB_terminal from './locales/en-GB/terminal.json'
import enGB_review from './locales/en-GB/review.json'
import enGB_workspace from './locales/en-GB/workspace.json'
import enGB_chrome from './locales/en-GB/chrome.json'
import zhTW_common from './locales/zh-TW/common.json'
import zhTW_settings from './locales/zh-TW/settings.json'
import zhTW_launch from './locales/zh-TW/launch.json'
import zhTW_terminal from './locales/zh-TW/terminal.json'
import zhTW_review from './locales/zh-TW/review.json'
import zhTW_workspace from './locales/zh-TW/workspace.json'
import zhTW_chrome from './locales/zh-TW/chrome.json'
import zhCN_common from './locales/zh-CN/common.json'
import zhCN_settings from './locales/zh-CN/settings.json'
import zhCN_launch from './locales/zh-CN/launch.json'
import zhCN_terminal from './locales/zh-CN/terminal.json'
import zhCN_review from './locales/zh-CN/review.json'
import zhCN_workspace from './locales/zh-CN/workspace.json'
import zhCN_chrome from './locales/zh-CN/chrome.json'
import ja_common from './locales/ja/common.json'
import ja_settings from './locales/ja/settings.json'
import ja_launch from './locales/ja/launch.json'
import ja_terminal from './locales/ja/terminal.json'
import ja_review from './locales/ja/review.json'
import ja_workspace from './locales/ja/workspace.json'
import ja_chrome from './locales/ja/chrome.json'

/** The source language: every other catalog is checked against it. */
export const source = {
  common: enUS_common,
  settings: enUS_settings,
  launch: enUS_launch,
  terminal: enUS_terminal,
  review: enUS_review,
  workspace: enUS_workspace,
  chrome: enUS_chrome,
}

export const resources = {
  'en-US': {
    common: enUS_common,
    settings: enUS_settings,
    launch: enUS_launch,
    terminal: enUS_terminal,
    review: enUS_review,
    workspace: enUS_workspace,
    chrome: enUS_chrome,
  },
  'en-GB': {
    common: enGB_common,
    settings: enGB_settings,
    launch: enGB_launch,
    terminal: enGB_terminal,
    review: enGB_review,
    workspace: enGB_workspace,
    chrome: enGB_chrome,
  },
  'zh-TW': {
    common: zhTW_common,
    settings: zhTW_settings,
    launch: zhTW_launch,
    terminal: zhTW_terminal,
    review: zhTW_review,
    workspace: zhTW_workspace,
    chrome: zhTW_chrome,
  },
  'zh-CN': {
    common: zhCN_common,
    settings: zhCN_settings,
    launch: zhCN_launch,
    terminal: zhCN_terminal,
    review: zhCN_review,
    workspace: zhCN_workspace,
    chrome: zhCN_chrome,
  },
  ja: {
    common: ja_common,
    settings: ja_settings,
    launch: ja_launch,
    terminal: ja_terminal,
    review: ja_review,
    workspace: ja_workspace,
    chrome: ja_chrome,
  },
}
