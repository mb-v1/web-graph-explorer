import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Cache to store already visited URLs
const urlCache = new Set();

// Add these constants at the top of the file
const LIMITS = {
  LINKS_PER_PAGE: 20,     // Increased from 5 to 20
  TOTAL_NODES: 50,        // Increased from 30 to 50
  PAGE_TIMEOUT: 3000,     // Increased slightly to 3 seconds
  CONCURRENT_FETCHES: 5
};

// Add a test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running!' });
});

async function getPageInfo(url) {
  console.log(`[${new Date().toISOString()}] Starting to fetch: ${url}`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote'
    ]
  });
  
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(LIMITS.PAGE_TIMEOUT);
    await page.setDefaultTimeout(LIMITS.PAGE_TIMEOUT);

    // Only skip images that aren't favicons
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url();
      if (resourceType === 'image' && !url.includes('favicon') && !url.includes('icon')) {
        req.abort();
      } else if (['stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: LIMITS.PAGE_TIMEOUT
    });

    const pageInfo = await page.evaluate((LINKS_PER_PAGE) => {
      // More comprehensive favicon detection
      function getFavicon() {
        const selectors = [
          'link[rel="icon"]',
          'link[rel="shortcut icon"]',
          'link[rel="apple-touch-icon"]',
          'link[rel="apple-touch-icon-precomposed"]',
          'link[rel*="icon"]',
          'link[type="image/x-icon"]',
          'link[type="image/png"]',
          'link[type="image/gif"]'
        ];
        
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.href) return el.href;
        }
        
        // Try default favicon location if nothing else found
        return '/favicon.ico';
      }

      // Get all links on the page
      const allLinks = Array.from(document.querySelectorAll('a'))
        .map(link => link.href)
        .filter(href => 
          href && 
          href.startsWith('http') && 
          !href.includes('#') &&
          !href.endsWith('.pdf') &&
          !href.endsWith('.jpg') &&
          !href.endsWith('.png') &&
          !href.includes('javascript:') &&
          !href.includes('mailto:')
        );

      // Remove duplicates but keep more links
      const uniqueLinks = [...new Set(allLinks)].slice(0, LINKS_PER_PAGE);
      
      return {
        title: document.title || url,
        links: uniqueLinks,
        favicon: getFavicon()
      };
    }, LIMITS.LINKS_PER_PAGE);

    // Validate favicon URL
    if (pageInfo.favicon && pageInfo.favicon.startsWith('/')) {
      try {
        const baseUrl = new URL(url);
        pageInfo.favicon = new URL(pageInfo.favicon, baseUrl.origin).toString();
      } catch (error) {
        console.log(`Error processing favicon URL: ${error.message}`);
        pageInfo.favicon = null;
      }
    }
    
    console.log(`[${new Date().toISOString()}] Successfully fetched ${url} with ${pageInfo.links.length} links`);
    return pageInfo;
  } catch (error) {
    console.log(`[${new Date().toISOString()}] Error fetching ${url}:`, error.message);
    return { title: url, links: [], favicon: null };
  } finally {
    await browser.close();
  }
}

async function crawlKHops(startUrl, k) {
  console.log(`[${new Date().toISOString()}] Starting crawl with limits:`, LIMITS);
  const nodes = new Map();
  const links = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  let processedCount = 0;
  
  try {
    while (queue.length > 0 && processedCount < LIMITS.TOTAL_NODES) {
      const batch = [];
      while (batch.length < LIMITS.CONCURRENT_FETCHES && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        if (next.depth > k) continue;
        
        try {
          // Always process the start URL, regardless of cache
          const normalizedUrl = new URL(next.url).toString();
          if (normalizedUrl === startUrl || !urlCache.has(normalizedUrl)) {
            urlCache.add(normalizedUrl);
            batch.push({ ...next, url: normalizedUrl });
          }
        } catch (error) {
          console.log(`Invalid URL skipped: ${next.url}`);
          continue;
        }
      }

      if (batch.length === 0) break;

      console.log(`[${new Date().toISOString()}] Processing batch of ${batch.length} URLs at depth ${batch[0].depth}`);
      
      const results = await Promise.allSettled(
        batch.map(async ({ url, depth }) => {
          const pageInfo = await getPageInfo(url);
          return { url, depth, pageInfo };
        })
      );

      // First pass: add nodes
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { url, pageInfo } = result.value;
          nodes.set(url, {
            id: url,
            title: pageInfo.title || url,
            favicon: pageInfo.favicon
          });
        }
      }

      // Second pass: add links and queue new URLs
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { url, depth, pageInfo } = result.value;
          
          if (depth < k) {
            for (const linkedUrl of pageInfo.links) {
              try {
                const normalizedLinkedUrl = new URL(linkedUrl).toString();
                
                // Add link regardless of whether we'll crawl the target
                links.add(JSON.stringify({ 
                  source: { id: url },
                  target: { id: normalizedLinkedUrl }
                }));

                // Only queue for crawling if we haven't seen it before
                if (!urlCache.has(normalizedLinkedUrl)) {
                  queue.push({ 
                    url: normalizedLinkedUrl, 
                    depth: depth + 1 
                  });
                }
              } catch (error) {
                console.log(`Invalid linked URL skipped: ${linkedUrl}`);
                continue;
              }
            }
          }
          processedCount++;
        }
      }

      console.log(`[${new Date().toISOString()}] Queue size: ${queue.length}, Processed: ${processedCount}`);
    }

    const graphData = {
      nodes: Array.from(nodes.values()).map(node => ({
        ...node,
        id: node.id,
        x: undefined,
        y: undefined,
        vx: undefined,
        vy: undefined
      })),
      links: Array.from(links)
        .map(link => {
          const { source, target } = JSON.parse(link);
          return {
            source: source.id,
            target: target.id
          };
        })
        .filter(link => nodes.has(link.source) && nodes.has(link.target))
    };

    console.log(`[${new Date().toISOString()}] Crawl completed. Nodes: ${graphData.nodes.length}, Links: ${graphData.links.length}`);
    return graphData;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error during crawl:`, error);
    return { nodes: [], links: [] };
  }
}

app.post('/api/crawl', async (req, res) => {
  const { url, k = 2, reset = false } = req.body;
  console.log('Received request to crawl:', url, 'with k =', k);
  
  try {
    if (reset) {
      console.log('Resetting URL cache');
      urlCache.clear();
    }
    
    // Even if the URL is in cache, we should still crawl it
    // Just remove it from cache first
    const normalizedUrl = new URL(url).toString();
    urlCache.delete(normalizedUrl);
    
    const graph = await crawlKHops(normalizedUrl, k);
    console.log('Sending response with nodes:', graph.nodes.length, 'links:', graph.links.length);
    res.json(graph);
  } catch (error) {
    console.error('Error in /api/crawl:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
    });
  }
});

app.post('/api/reset', (req, res) => {
  console.log('Resetting URL cache');
  urlCache.clear();
  res.json({ message: 'Cache cleared' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 