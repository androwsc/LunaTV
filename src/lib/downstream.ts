/* eslint-disable @typescript-eslint/no-explicit-any */

import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { getCachedSearchPage, setCachedSearchPage } from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';
// 使用轻量级 switch-chinese 库（93.8KB vs opencc-js 5.6MB）
import stcasc, { ChineseType } from 'switch-chinese';

// 创建模块级别的繁简转换器实例
const converter = stcasc();

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

/**
 * 通用的带缓存搜索函数
 */
async function searchWithCache(
  apiSite: ApiSite,
  query: string,
  page: number,
  url: string,
  timeoutMs = 8000
): Promise<{ results: SearchResult[]; pageCount?: number }> {
  // 先查缓存
  const cached = getCachedSearchPage(apiSite.key, query, page);
  if (cached) {
    if (cached.status === 'ok') {
      return { results: cached.data, pageCount: cached.pageCount };
    } else {
      return { results: [] };
    }
  }

  // 缓存未命中，发起网络请求
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 403) {
        setCachedSearchPage(apiSite.key, query, page, 'forbidden', []);
      }
      return { results: [] };
    }

    const data = await response.json();
    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      // 空结果不做负缓存要求，这里不写入缓存
      return { results: [] };
    }

    // 处理结果数据
    const allResults = data.list.map((item: ApiSearchItem) => {
      let episodes: string[] = [];
      let titles: string[] = [];

      // 使用正则表达式从 vod_play_url 提取 m3u8 链接
      if (item.vod_play_url) {
        // 先用 $$$ 分割
        const vod_play_url_array = item.vod_play_url.split('$$$');
        // 分集之间#分割，标题和播放链接 $ 分割
        vod_play_url_array.forEach((url: string) => {
          const matchEpisodes: string[] = [];
          const matchTitles: string[] = [];
          const title_url_array = url.split('#');
          title_url_array.forEach((title_url: string) => {
            const episode_title_url = title_url.split('$');
            if (
              episode_title_url.length === 2 &&
              episode_title_url[1].endsWith('.m3u8')
            ) {
              matchTitles.push(episode_title_url[0]);
              matchEpisodes.push(episode_title_url[1]);
            }
          });
          if (matchEpisodes.length > episodes.length) {
            episodes = matchEpisodes;
            titles = matchTitles;
          }
        });
      }

      return {
        id: item.vod_id.toString(),
        title: item.vod_name.trim().replace(/\s+/g, ' '),
        poster: item.vod_pic?.trim() || '', // 确保poster为有效字符串，过滤空白
        episodes,
        episodes_titles: titles,
        source: apiSite.key,
        source_name: apiSite.name,
        class: item.vod_class,
        year: item.vod_year
          ? item.vod_year.match(/\d{4}/)?.[0] || ''
          : 'unknown',
        desc: cleanHtmlTags(item.vod_content || ''),
        type_name: item.type_name,
        douban_id: item.vod_douban_id,
        remarks: item.vod_remarks, // 传递备注信息（如"已完结"等）
      };
    });

    // 过滤掉集数为 0 的结果
    const results = allResults.filter((result: SearchResult) => result.episodes.length > 0);

    const pageCount = page === 1 ? data.pagecount || 1 : undefined;
    // 写入缓存（成功）
    setCachedSearchPage(apiSite.key, query, page, 'ok', results, pageCount);
    return { results, pageCount };
  } catch (error: any) {
    clearTimeout(timeoutId);
    // 识别被 AbortController 中止（超时）
    const aborted = error?.name === 'AbortError' || error?.code === 20 || error?.message?.includes('aborted');
    if (aborted) {
      setCachedSearchPage(apiSite.key, query, page, 'timeout', []);
    }
    return { results: [] };
  }
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  precomputedVariants?: string[] // 新增：预计算的变体
): Promise<SearchResult[]> {
  try {
    const apiBaseUrl = apiSite.api;

    // 智能变体数量：有标点符号时用4个变体，否则用3个
    const hasSpecialChars = /[：；，。！？、""''（）【】《》:;,.!?"'()\[\]<>]/.test(query);
    const variantLimit = hasSpecialChars ? 4 : 3;
    const searchVariants = precomputedVariants || generateSearchVariants(query).slice(0, variantLimit);
    const seenIds = new Set<string>(); // 用于去重
    let results: SearchResult[] = [];
    let pageCountFromFirst = 0;

    // 调试：输出搜索变体
    console.log(`[DEBUG] 搜索变体 for "${query}":`, searchVariants);

    // 🚀 优化：并行搜索所有变体，第一个有结果的立即返回
    const variantPromises = searchVariants.map(async (variant, index) => {
      const apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(variant);
      console.log(`[DEBUG] 并行搜索变体 ${index + 1}/${searchVariants.length}: "${variant}"`);

      try {
        const result = await searchWithCache(apiSite, variant, 1, apiUrl, 8000);
        return { variant, index, result };
      } catch (error) {
        console.log(`[DEBUG] 变体 "${variant}" 搜索失败:`, error);
        return { variant, index, result: { results: [], pageCount: 0 } };
      }
    });

    // 等待所有变体搜索完成
    const variantResults = await Promise.all(variantPromises);

    // 按原始顺序处理结果，优先使用靠前的变体结果
    for (const { variant, index, result } of variantResults.sort((a, b) => a.index - b.index)) {
      if (result.results.length > 0) {
        console.log(`[DEBUG] 变体 "${variant}" 找到 ${result.results.length} 个结果`);

        // 去重添加结果
        result.results.forEach(r => {
          const uniqueKey = `${r.source}_${r.id}`;
          if (!seenIds.has(uniqueKey)) {
            seenIds.add(uniqueKey);
            results.push(r);
          }
        });

        // 记录第一个有结果的变体的页数
        if (pageCountFromFirst === 0 && result.pageCount) {
          pageCountFromFirst = result.pageCount;
        }

        // 如果已经找到足够多的结果（≥5个），停止处理
        if (results.length >= 5) {
          console.log(`[DEBUG] 已找到足够结果，停止处理其他变体`);
          break;
        }
      } else {
        console.log(`[DEBUG] 变体 "${variant}" 无结果`);
      }
    }

    // 如果没有任何结果，返回空数组
    if (results.length === 0) {
      return [];
    }

    console.log(`[DEBUG] 最终找到 ${results.length} 个唯一结果`);

    // 使用原始查询进行后续分页
    query = searchVariants[0];

    const config = await getConfig();
    const MAX_SEARCH_PAGES: number = config.SiteConfig.SearchDownstreamMaxPage;

    // 获取总页数
    const pageCount = pageCountFromFirst || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);

    // 如果有额外页数，获取更多页的结果
    if (pagesToFetch > 0) {
      const additionalPagePromises = [];

      for (let page = 2; page <= pagesToFetch + 1; page++) {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const pagePromise = (async () => {
          // 使用新的缓存搜索函数处理分页
          const pageResult = await searchWithCache(apiSite, query, page, pageUrl, 8000);
          return pageResult.results;
        })();

        additionalPagePromises.push(pagePromise);
      }

      // 等待所有额外页的结果
      const additionalResults = await Promise.all(additionalPagePromises);

      // 合并所有页的结果
      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    return results;
  } catch (error) {
    return [];
  }
}

/**
 * 计算搜索结果的相关性分数
 * @param originalQuery 原始查询
 * @param variant 搜索变体
 * @param results 搜索结果
 * @returns 相关性分数（越高越相关）
 */
function calculateRelevanceScore(originalQuery: string, variant: string, results: SearchResult[]): number {
  let score = 0;

  // 基础分数：结果数量（越多越好，但有上限）
  score += Math.min(results.length * 10, 100);

  // 变体质量分数：越接近原始查询越好
  if (variant === originalQuery) {
    score += 1000; // 完全匹配最高分
  } else if (variant.includes('：') && originalQuery.includes(' ')) {
    score += 500; // 空格变冒号的变体较高分
  } else if (variant.includes(':') && originalQuery.includes(' ')) {
    score += 400; // 空格变英文冒号
  }
  // 移除数字变体加分逻辑，依赖智能匹配处理

  // 结果质量分数：检查结果标题的匹配程度
  const originalWords = originalQuery.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, '').split(/\s+/).filter(w => w.length > 0);

  results.forEach(result => {
    const title = result.title.toLowerCase();
    let titleScore = 0;

    // 检查原始查询中的每个词是否在标题中
    let matchedWords = 0;
    originalWords.forEach(word => {
      if (title.includes(word)) {
        // 较长的词（如"血脉诅咒"）给予更高权重
        const wordWeight = word.length > 2 ? 100 : 50;
        titleScore += wordWeight;
        matchedWords++;
      }
    });

    // 完全匹配奖励：所有词都匹配时给予巨大奖励
    if (matchedWords === originalWords.length && originalWords.length > 1) {
      titleScore += 500; // 大幅提高完全匹配的奖励
    }

    // 部分匹配惩罚：如果只匹配了部分词，降低分数
    if (matchedWords < originalWords.length && originalWords.length > 1) {
      titleScore -= 100; // 惩罚不完整匹配
    }

    // 标题长度惩罚：过长的标题降低优先级（可能不够精确）
    if (title.length > 50) {
      titleScore -= 20;
    }

    // 年份奖励：较新的年份获得更高分数
    if (result.year && result.year !== 'unknown') {
      const year = parseInt(result.year);
      if (year >= 2020) {
        titleScore += 30;
      } else if (year >= 2010) {
        titleScore += 10;
      }
    }

    score += titleScore;
  });

  return score;
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;

/**
 * 生成数字变体，处理中文数字、罗马数字、阿拉伯数字、S格式的转换
 * 例如："中国奇谭 第二季" -> "中国奇谭2"
 *       "进击的巨人Ⅱ" -> "进击的巨人2"
 *       "权力的游戏S2" -> "权力的游戏第二季"
 * @param query 原始查询
 * @returns 数字变体数组
 */
function generateNumberVariants(query: string): string[] {
  const variants: string[] = [];

  // 中文数字到阿拉伯数字的映射
  const chineseToArabic: { [key: string]: string } = {
    '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
    '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
  };

  // 罗马数字到阿拉伯数字的映射
  const romanToArabic: { [key: string]: string } = {
    'Ⅰ': '1', 'Ⅱ': '2', 'Ⅲ': '3', 'Ⅳ': '4', 'Ⅴ': '5',
    'Ⅵ': '6', 'Ⅶ': '7', 'Ⅷ': '8', 'Ⅸ': '9', 'Ⅹ': '10',
    'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5',
    'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10',
  };

  // 阿拉伯数字到中文数字的映射
  const arabicToChinese = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  // 辅助函数：清理基础名称（去掉末尾标点符号和空格）
  const cleanBase = (str: string) => str.replace(/[：:；;，,。.！!？?\s]+$/, '').trim();

  // 1. 处理"第X季/部/集"格式
  const seasonPattern = /第([一二三四五六七八九十\d]+)(季|部|集|期)/;
  const seasonMatch = seasonPattern.exec(query);
  if (seasonMatch) {
    const fullMatch = seasonMatch[0];
    const number = seasonMatch[1];
    const arabicNumber = chineseToArabic[number] || number;
    const base = cleanBase(query.replace(fullMatch, ''));
    if (base) {
      variants.push(`${base}${arabicNumber}`);
    }
  }

  // 2. 处理末尾纯数字（如"中国奇谭2"）-> "中国奇谭第二季"
  const endNumberMatch = query.match(/^(.+?)\s*(\d+)$/);
  if (endNumberMatch) {
    const base = endNumberMatch[1].trim();
    const number = parseInt(endNumberMatch[2]);
    if (number >= 1 && number <= 10) {
      variants.push(`${base}第${arabicToChinese[number]}季`);
    }
  }

  // 3. 处理罗马数字（如"进击的巨人Ⅱ"）-> "进击的巨人2"
  const romanPattern = /^(.+?)\s*(Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|Ⅶ|Ⅷ|Ⅸ|Ⅹ|VIII|VII|VI|IV|IX|III|II|I|V|X)$/;
  const romanMatch = query.match(romanPattern);
  if (romanMatch) {
    const base = romanMatch[1].trim();
    const roman = romanMatch[2];
    const arabicNumber = romanToArabic[roman];
    if (base && arabicNumber) {
      variants.push(`${base}${arabicNumber}`);
    }
  }

  // 4. 处理S格式（如"权力的游戏S2"或"权力的游戏S02"）-> "权力的游戏第二季"
  const sFormatMatch = query.match(/^(.+?)\s*[Ss]0*(\d+)$/);
  if (sFormatMatch) {
    const base = sFormatMatch[1].trim();
    const number = parseInt(sFormatMatch[2]);
    if (base && number >= 1 && number <= 10) {
      variants.push(`${base}第${arabicToChinese[number]}季`);
    }
  }

  // 5. 反向：从"第X季"生成S格式（如"权力的游戏第二季"-> "权力的游戏S2"）
  if (seasonMatch) {
    const fullMatch = seasonMatch[0];
    const number = seasonMatch[1];
    const suffix = seasonMatch[2];
    if (suffix === '季') {
      const arabicNumber = chineseToArabic[number] || number;
      const base = cleanBase(query.replace(fullMatch, ''));
      if (base && !variants.includes(`${base}S${arabicNumber}`)) {
        variants.push(`${base}S${arabicNumber}`);
      }
    }
  }

  // 限制返回前2个最有可能的变体
  return variants.slice(0, 2);
}

/**
 * 生成搜索查询的多种变体，提高搜索命中率
 * @param originalQuery 原始查询
 * @returns 按优先级排序的搜索变体数组
 */
export function generateSearchVariants(originalQuery: string): string[] {
  const variants: string[] = [];
  const trimmed = originalQuery.trim();

  // 1. 原始查询（最高优先级）
  variants.push(trimmed);

  // 2. 数字变体生成（处理"第二季" <-> "2"转换，优先级高因为采集源命名差异常见）
  const numberVariants = generateNumberVariants(trimmed);
  numberVariants.forEach(variant => {
    if (!variants.includes(variant)) {
      variants.push(variant);
    }
  });

  // 3. 处理中文标点符号变体
  const chinesePunctuationVariants = generateChinesePunctuationVariants(trimmed);
  chinesePunctuationVariants.forEach(variant => {
    if (!variants.includes(variant)) {
      variants.push(variant);
    }
  });

  // 如果包含空格，生成额外变体
  if (trimmed.includes(' ')) {
    // 5. 去除所有空格
    const noSpaces = trimmed.replace(/\s+/g, '');
    if (noSpaces !== trimmed) {
      variants.push(noSpaces);
    }

    // 6. 标准化空格（多个空格合并为一个）
    const normalizedSpaces = trimmed.replace(/\s+/g, ' ');
    if (normalizedSpaces !== trimmed && !variants.includes(normalizedSpaces)) {
      variants.push(normalizedSpaces);
    }

    // 7. 提取关键词组合（针对"中餐厅 第九季"这种情况）
    const keywords = trimmed.split(/\s+/);
    if (keywords.length >= 2) {
      // 主要关键词 + 季/集等后缀
      const mainKeyword = keywords[0];
      const lastKeyword = keywords[keywords.length - 1];

      // 如果最后一个词包含"第"、"季"、"集"等，尝试组合
      if (/第|季|集|部|篇|章/.test(lastKeyword)) {
        const combined = mainKeyword + lastKeyword;
        if (!variants.includes(combined)) {
          variants.push(combined);
        }
      }

      // 8. 空格变冒号的变体（重要！针对"死神来了 血脉诅咒" -> "死神来了：血脉诅咒"）
      const withColon = trimmed.replace(/\s+/g, '：');
      if (!variants.includes(withColon)) {
        variants.push(withColon);
      }

      // 9. 空格变英文冒号的变体
      const withEnglishColon = trimmed.replace(/\s+/g, ':');
      if (!variants.includes(withEnglishColon)) {
        variants.push(withEnglishColon);
      }

      // 仅使用主关键词搜索（过滤无意义的词）
      const meaninglessWords = ['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by'];
      if (!variants.includes(mainKeyword) &&
          !meaninglessWords.includes(mainKeyword.toLowerCase()) &&
          mainKeyword.length > 2) {
        variants.push(mainKeyword);
      }
    }
  }

  // 去重
  const uniqueVariants = Array.from(new Set(variants));

  // 最后：只对前几个优先级高的变体进行繁体转简体处理
  // 优化：使用 detect() 先检测，避免对简体输入进行无用转换（detect比simplized快1.5-3倍）
  const finalVariants: string[] = [];
  const MAX_VARIANTS_TO_CONVERT = 3; // 只转换前3个变体

  uniqueVariants.forEach((variant, index) => {
    finalVariants.push(variant);
    // 只对前几个变体进行繁转简
    if (index < MAX_VARIANTS_TO_CONVERT) {
      // 优化：先用 detect() 检测，简体直接跳过（快1.5-3倍）
      const type = converter.detect(variant);
      if (type !== ChineseType.SIMPLIFIED) {
        const simplifiedVariant = converter.simplized(variant);
        if (simplifiedVariant !== variant && !finalVariants.includes(simplifiedVariant)) {
          finalVariants.push(simplifiedVariant);
          console.log(`[DEBUG] 添加繁转简变体: "${variant}" -> "${simplifiedVariant}"`);
        }
      }
    }
  });

  return finalVariants;
}

/**
 * 生成中文标点符号的搜索变体
 * @param query 原始查询
 * @returns 标点符号变体数组
 */
function generateChinesePunctuationVariants(query: string): string[] {
  const variants: string[] = [];

  // 检查是否包含中文标点符号
  const chinesePunctuation = /[：；，。！？、""''（）【】《》]/;
  if (!chinesePunctuation.test(query)) {
    return variants;
  }

  // 中文冒号变体 (针对"死神来了：血脉诅咒"这种情况)
  if (query.includes('：')) {
    // 优先级1: 替换为空格 (最可能匹配，如"死神来了 血脉诅咒" 能匹配到 "死神来了6：血脉诅咒")
    const withSpace = query.replace(/：/g, ' ');
    variants.push(withSpace);

    // 优先级2: 完全去除冒号
    const noColon = query.replace(/：/g, '');
    variants.push(noColon);

    // 优先级3: 替换为英文冒号
    const englishColon = query.replace(/：/g, ':');
    variants.push(englishColon);

    // 优先级4: 提取冒号前的主标题 (降低优先级，避免匹配到错误的系列)
    const beforeColon = query.split('：')[0].trim();
    if (beforeColon && beforeColon !== query) {
      variants.push(beforeColon);
    }

    // 优先级5: 提取冒号后的副标题
    const afterColon = query.split('：')[1]?.trim();
    if (afterColon) {
      variants.push(afterColon);
    }
  }

  // 其他中文标点符号处理
  let cleanedQuery = query;

  // 替换中文标点为对应英文标点
  cleanedQuery = cleanedQuery.replace(/；/g, ';');
  cleanedQuery = cleanedQuery.replace(/，/g, ',');
  cleanedQuery = cleanedQuery.replace(/。/g, '.');
  cleanedQuery = cleanedQuery.replace(/！/g, '!');
  cleanedQuery = cleanedQuery.replace(/？/g, '?');
  cleanedQuery = cleanedQuery.replace(/"/g, '"');
  cleanedQuery = cleanedQuery.replace(/"/g, '"');
  cleanedQuery = cleanedQuery.replace(/'/g, "'");
  cleanedQuery = cleanedQuery.replace(/'/g, "'");
  cleanedQuery = cleanedQuery.replace(/（/g, '(');
  cleanedQuery = cleanedQuery.replace(/）/g, ')');
  cleanedQuery = cleanedQuery.replace(/【/g, '[');
  cleanedQuery = cleanedQuery.replace(/】/g, ']');
  cleanedQuery = cleanedQuery.replace(/《/g, '<');
  cleanedQuery = cleanedQuery.replace(/》/g, '>');

  if (cleanedQuery !== query) {
    variants.push(cleanedQuery);
  }

  // 完全去除所有标点符号
  const noPunctuation = query.replace(/[：；，。！？、""''（）【】《》:;,.!?"'()[\]<>]/g, '');
  if (noPunctuation !== query && noPunctuation.trim()) {
    variants.push(noPunctuation);
  }

  return variants;
}

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = [];
  let titles: string[] = [];

  // 处理播放源拆分
  if (videoDetail.vod_play_url) {
    // 先用 $$$ 分割
    const vod_play_url_array = videoDetail.vod_play_url.split('$$$');
    // 分集之间#分割，标题和播放链接 $ 分割
    vod_play_url_array.forEach((url: string) => {
      const matchEpisodes: string[] = [];
      const matchTitles: string[] = [];
      const title_url_array = url.split('#');
      title_url_array.forEach((title_url: string) => {
        const episode_title_url = title_url.split('$');
        if (
          episode_title_url.length === 2 &&
          episode_title_url[1].endsWith('.m3u8')
        ) {
          matchTitles.push(episode_title_url[0]);
          matchEpisodes.push(episode_title_url[1]);
        }
      });
      if (matchEpisodes.length > episodes.length) {
        episodes = matchEpisodes;
        titles = matchTitles;
      }
    });
  }

  // 如果播放源为空，则尝试从内容中解析 m3u8
  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: videoDetail.vod_name,
    poster: videoDetail.vod_pic?.trim() || '', // 确保poster为有效字符串，过滤空白
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
    remarks: videoDetail.vod_remarks, // 传递备注信息（如"已完结"等）
  };
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const html = await response.text();
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去重并清理链接前缀
  matches = Array.from(new Set(matches)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });

  // 根据 matches 数量生成剧集标题
  const episodes_titles = Array.from({ length: matches.length }, (_, i) =>
    (i + 1).toString()
  );

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? titleMatch[1].trim() : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  return {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    episodes_titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
    remarks: undefined, // HTML解析无法获取remarks信息
  };
}
