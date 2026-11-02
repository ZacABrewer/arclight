import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseEnclosure, FeedParseError, parseDuration, parseFeed, parseFeedDate, plainText } from './feed.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseFeed: RSS 2.0', () => {
  const feed = parseFeed(fixture('rss2-basic.xml'));

  it('reads the channel', () => {
    expect(feed.title).toBe('Plain Old Radio');
    expect(feed.description).toBe('A feed with nothing but RSS 2.0 & enclosures.');
    expect(feed.link).toBe('https://example.com/plain');
    expect(feed.imageUrl).toBe('https://example.com/plain/cover.jpg');
    expect(feed.language).toBe('en-us');
    expect(feed.ttlMinutes).toBe(180);
    expect(feed.categories).toEqual(['Talk']);
    expect(feed.feedType).toBe('episodic');
    expect(feed.podcastGuid).toBeNull();
  });

  it('skips items without audio, drops duplicate guids and falls back to the enclosure URL as guid', () => {
    expect(feed.episodes.map((e) => e.guid)).toEqual(['plain-2', 'https://cdn.example.com/plain/ep1.mp3']);
    const [two, one] = feed.episodes;
    expect(two!.description).toBe('Second episode.\nWith two paragraphs.');
    expect(two!.publishedAt).toBe('2025-01-07T10:00:00.000Z');
    expect(two!.enclosure).toEqual({ url: 'https://cdn.example.com/plain/ep2.mp3', type: 'audio/mpeg', length: 2048 });
    expect(two!.link).toBe('https://example.com/plain/2');
    expect(one!.publishedAt).toBe('2025-01-01T10:00:00.000Z');
  });
});

describe('parseFeed: iTunes tags', () => {
  const feed = parseFeed(fixture('itunes.xml'));

  it('reads channel tags', () => {
    expect(feed.author).toBe('Example Studios');
    expect(feed.imageUrl).toBe('https://example.com/hour/art.png');
    expect(feed.explicit).toBe(true);
    expect(feed.feedType).toBe('serial');
    expect(feed.categories).toEqual(['Society & Culture', 'Documentary', 'History']);
    expect(feed.selfUrl).toBe('https://feeds.example.com/hour.xml');
  });

  it('reads episode tags', () => {
    const [ep, trailer] = feed.episodes;
    expect(ep!.title).toBe('S2E1: A New Season');
    expect(ep!.description).toBe('Full show notes & links.');
    expect(ep!.durationSeconds).toBe(3723);
    expect(ep!.season).toBe(2);
    expect(ep!.episodeNumber).toBe(1);
    expect(ep!.explicit).toBe(false);
    expect(ep!.imageUrl).toBe('https://example.com/hour/s2e1.jpg');
    expect(ep!.enclosure?.type).toBe('audio/x-m4a');
    expect(trailer!.episodeType).toBe('trailer');
    expect(trailer!.durationSeconds).toBe(95);
    // Inherits the channel's explicit flag.
    expect(trailer!.explicit).toBe(true);
  });
});

describe('parseFeed: Podcasting 2.0', () => {
  const feed = parseFeed(fixture('podcasting20.xml'));

  it('reads channel tags', () => {
    expect(feed.podcastGuid).toBe('917393e3-1b1e-5cef-ace4-edaa54e1f810');
    expect(feed.locked).toBe(true);
    expect(feed.funding).toEqual([{ url: 'https://example.com/ns/support', title: 'Support the show' }]);
  });

  it('reads chapters, transcripts, persons, season/episode and alternate enclosures', () => {
    const ep = feed.episodes[0]!;
    expect(ep.season).toBe(1);
    expect(ep.episodeNumber).toBe(7);
    expect(ep.chaptersUrl).toBe('https://example.com/ns/1/chapters.json');
    expect(ep.transcripts).toEqual([
      { url: 'https://example.com/ns/1/transcript.vtt', type: 'text/vtt', language: 'en', rel: null },
      { url: 'https://example.com/ns/1/transcript.srt', type: 'application/x-subrip', language: null, rel: 'captions' },
    ]);
    expect(ep.persons).toEqual([
      { name: 'Alex Example', role: 'host', href: 'https://example.com/people/alex', img: 'https://example.com/people/alex.jpg' },
      { name: 'Sam Sample', role: 'guest', href: null, img: null },
    ]);
    expect(ep.alternateEnclosures).toEqual([
      { url: 'https://cdn.example.com/ns/1.mp4', type: 'video/mp4', length: 90000, title: 'Video', bitrate: 2000000 },
      // The ipfs:// source is skipped for the first http(s) one.
      { url: 'https://cdn.example.com/ns/1.opus', type: 'audio/opus', length: 1500, title: 'Small', bitrate: null },
    ]);
  });

  it('uses an alternate enclosure when the item has no <enclosure>', () => {
    const ep = feed.episodes[1]!;
    expect(ep.enclosure?.url).toBe('https://cdn.example.com/ns/0.aac');
    expect(ep.alternateEnclosures).toEqual([]);
  });
});

describe('parseFeed: namespace prefixes are matched by URI', () => {
  it('reads iTunes and Podcasting 2.0 tags under unusual prefixes', () => {
    const feed = parseFeed(fixture('prefix-alias.xml'));
    expect(feed.author).toBe('Prefix People');
    expect(feed.imageUrl).toBe('https://example.com/odd/art.jpg');
    expect(feed.newFeedUrl).toBe('https://feeds.example.com/odd-new.xml');
    expect(feed.podcastGuid).toBe('aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee');
    expect(feed.episodes[0]!.durationSeconds).toBe(750);
    expect(feed.episodes[0]!.chaptersUrl).toBe('https://example.com/odd/1.json');
  });
});

describe('parseFeed: Atom', () => {
  it('reads entries with enclosure links', () => {
    const feed = parseFeed(fixture('atom.xml'));
    expect(feed.title).toBe('Atom Audio');
    expect(feed.author).toBe('Atom Author');
    expect(feed.link).toBe('https://example.com/atom');
    expect(feed.imageUrl).toBe('https://example.com/atom/logo.png');
    expect(feed.episodes).toHaveLength(1);
    expect(feed.episodes[0]).toMatchObject({
      guid: 'urn:uuid:atom-1',
      title: 'First entry',
      publishedAt: '2025-04-01T09:00:00.000Z',
      link: 'https://example.com/atom/1',
      description: 'Entry summary.',
      enclosure: { url: 'https://cdn.example.com/atom/1.ogg', type: 'audio/ogg', length: 777 },
    });
  });
});

describe('parseFeed: broken feeds', () => {
  it('copes with bad dates, bad lengths, invalid enclosure URLs and missing titles', () => {
    const feed = parseFeed(fixture('broken-messy.xml'));
    expect(feed.title).toBe('Messy & Proud');
    const [bad, localized, untitled] = feed.episodes;
    expect(bad!.publishedAt).toBeNull();
    expect(bad!.enclosure?.length).toBeNull();
    expect(localized!.publishedAt).toBe('2025-01-06T10:00:00.000Z');
    expect(localized!.enclosure?.url).toBe('https://cdn.example.com/messy/2.mp3');
    expect(untitled!.title).toBe('Untitled episode');
  });

  const cases: Array<[string, string, RegExp]> = [
    ['empty', '   ', /empty/],
    ['a web page', '<!DOCTYPE html><html><body>Moved</body></html>', /web page/],
    ['plain text', 'Service unavailable', /not XML/],
    ['RSS 1.0', '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>x</title></channel></rdf:RDF>', /RSS 1\.0/],
    ['no channel', '<?xml version="1.0"?><rss version="2.0"></rss>', /channel|not an RSS/],
    ['no title', '<rss version="2.0"><channel><description>d</description></channel></rss>', /no title/],
    ['another XML document', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>', /not an RSS or Atom/],
  ];
  for (const [label, body, message] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => parseFeed(body)).toThrow(FeedParseError);
      expect(() => parseFeed(body)).toThrow(message);
    });
  }

  it('accepts a byte order mark', () => {
    expect(parseFeed(`﻿${fixture('rss2-basic.xml')}`).title).toBe('Plain Old Radio');
  });
});

describe('feed helpers', () => {
  it('parses durations', () => {
    expect(parseDuration('3600')).toBe(3600);
    expect(parseDuration('90.6')).toBe(91);
    expect(parseDuration('01:30')).toBe(90);
    expect(parseDuration('1:00:01')).toBe(3601);
    expect(parseDuration('about an hour')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  it('parses dates', () => {
    expect(parseFeedDate('2025-02-03T04:05:06Z')).toBe('2025-02-03T04:05:06.000Z');
    expect(parseFeedDate('Sun, 02 Feb 2025 00:00:00 +0100')).toBe('2025-02-01T23:00:00.000Z');
    expect(parseFeedDate('garbage')).toBeNull();
  });

  it('turns HTML into plain text', () => {
    expect(plainText('<p>One &amp; two</p><script>alert(1)</script><p>Three&#39;s&nbsp;four</p>')).toBe("One & two\nThree's four");
    expect(plainText('x'.repeat(30), 10)).toHaveLength(10);
  });

  it('chooses an enclosure by preference', () => {
    const mp3 = { url: 'https://cdn.example.com/a.mp3', type: 'audio/mpeg', length: 3000 };
    const mp4 = { url: 'https://cdn.example.com/a.mp4', type: 'video/mp4', length: 90000 };
    const opus = { url: 'https://cdn.example.com/a.opus', type: 'audio/opus', length: 1500 };
    expect(chooseEnclosure(mp3, [mp4, opus], 'feed')).toBe(mp3);
    expect(chooseEnclosure(mp3, [mp4, opus], 'video')).toBe(mp4);
    expect(chooseEnclosure(mp4, [mp3], 'audio')).toBe(mp3);
    expect(chooseEnclosure(mp3, [mp4, opus], 'smallest')).toBe(opus);
    expect(chooseEnclosure(mp3, [mp4, opus], 'largest')).toBe(mp4);
    expect(chooseEnclosure(null, [], 'feed')).toBeNull();
  });
});
