#!/usr/bin/env python3
"""
Scrape video URLs from Autodesk help documentation pages.

This script can:
- Scrape a single URL
- Scrape multiple URLs from a file
- Extract videos from YouTube, Vimeo, and other embedded players
- Save results to JSON or CSV
"""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


def extract_video_urls(html_content, base_url):
    """Extract video URLs from HTML content."""
    video_urls = set()

    # YouTube patterns
    youtube_patterns = [
        r'(?:https?:)?//(?:www\.)?(?:youtube\.com/(?:watch\?v=|embed/|v/)|youtu\.be/)([\w-]{11})',
        r'(?:https?:)?//(?:www\.)?youtube\.com/playlist\?list=([\w-]+)',
    ]

    # Vimeo patterns
    vimeo_patterns = [
        r'(?:https?:)?//(?:www\.)?vimeo\.com/(\d+)',
        r'(?:https?:)?//player\.vimeo\.com/video/(\d+)',
    ]

    # Generic video file patterns
    video_file_patterns = [
        r'(?:https?:)?[^\s"\'<>]+\.(?:mp4|webm|ogg|mov|avi)(?:\?[^\s"\'<>]*)?',
    ]

    # iframe src patterns
    iframe_pattern = r'<iframe[^>]+src=["\']([^"\']+)["\']'

    # video tag patterns
    video_tag_pattern = r'<video[^>]+src=["\']([^"\']+)["\']'

    # Extract from iframes
    for match in re.finditer(iframe_pattern, html_content, re.IGNORECASE):
        src = match.group(1)
        video_urls.add(src)

    # Extract from video tags
    for match in re.finditer(video_tag_pattern, html_content, re.IGNORECASE):
        src = match.group(1)
        video_urls.add(src)

    # Extract YouTube URLs
    for pattern in youtube_patterns:
        for match in re.finditer(pattern, html_content, re.IGNORECASE):
            video_id = match.group(1)
            if 'playlist' in pattern:
                video_urls.add(f'https://www.youtube.com/playlist?list={video_id}')
            else:
                video_urls.add(f'https://www.youtube.com/watch?v={video_id}')

    # Extract Vimeo URLs
    for pattern in vimeo_patterns:
        for match in re.finditer(pattern, html_content, re.IGNORECASE):
            video_id = match.group(1)
            video_urls.add(f'https://vimeo.com/{video_id}')

    # Extract direct video file URLs
    for pattern in video_file_patterns:
        for match in re.finditer(pattern, html_content, re.IGNORECASE):
            url = match.group(0)
            # Make relative URLs absolute
            if url.startswith('//'):
                url = f'https:{url}'
            elif url.startswith('/'):
                url = urljoin(base_url, url)
            video_urls.add(url)

    # Extract data-video attributes
    data_video_pattern = r'data-video=["\']([^"\']+)["\']'
    for match in re.finditer(data_video_pattern, html_content, re.IGNORECASE):
        src = match.group(1)
        if src.startswith('//'):
            src = f'https:{src}'
        elif src.startswith('/'):
            src = urljoin(base_url, src)
        video_urls.add(src)

    return sorted(list(video_urls))


def scrape_page(url, timeout=30):
    """Scrape a single page for video URLs."""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=timeout)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, 'html.parser')
        html_content = str(soup)

        video_urls = extract_video_urls(html_content, url)

        # Also try to find page title
        title = ''
        title_tag = soup.find('title')
        if title_tag:
            title = title_tag.get_text().strip()

        return {
            'url': url,
            'title': title,
            'video_urls': video_urls,
            'video_count': len(video_urls),
            'status': 'success'
        }
    except Exception as e:
        return {
            'url': url,
            'title': '',
            'video_urls': [],
            'video_count': 0,
            'status': f'error: {str(e)}'
        }


def scrape_urls_from_file(file_path):
    """Read URLs from a file (one per line)."""
    with open(file_path, 'r', encoding='utf-8') as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    return urls


def save_results(results, output_file, format='json'):
    """Save scraping results to a file."""
    if format == 'json':
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)
    elif format == 'csv':
        import csv
        with open(output_file, 'w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['URL', 'Title', 'Video Count', 'Video URLs', 'Status'])
            for result in results:
                writer.writerow([
                    result['url'],
                    result['title'],
                    result['video_count'],
                    '; '.join(result['video_urls']),
                    result['status']
                ])
    else:
        # Plain text format
        with open(output_file, 'w', encoding='utf-8') as f:
            for result in results:
                f.write(f"URL: {result['url']}\n")
                f.write(f"Title: {result['title']}\n")
                f.write(f"Status: {result['status']}\n")
                f.write(f"Video Count: {result['video_count']}\n")
                if result['video_urls']:
                    f.write("Videos:\n")
                    for video_url in result['video_urls']:
                        f.write(f"  - {video_url}\n")
                f.write("\n" + "-"*80 + "\n\n")


def main():
    parser = argparse.ArgumentParser(
        description='Scrape video URLs from Autodesk help documentation pages'
    )
    parser.add_argument(
        'urls',
        nargs='*',
        help='URLs to scrape (if not provided, use --file)'
    )
    parser.add_argument(
        '--file', '-f',
        help='File containing URLs to scrape (one per line)'
    )
    parser.add_argument(
        '--output', '-o',
        default='autodesk_videos.json',
        help='Output file path (default: autodesk_videos.json)'
    )
    parser.add_argument(
        '--format',
        choices=['json', 'csv', 'txt'],
        default='json',
        help='Output format (default: json)'
    )
    parser.add_argument(
        '--timeout',
        type=int,
        default=30,
        help='Request timeout in seconds (default: 30)'
    )

    args = parser.parse_args()

    # Get URLs to scrape
    if args.file:
        urls = scrape_urls_from_file(args.file)
    elif args.urls:
        urls = args.urls
    else:
        parser.error('Either provide URLs as arguments or use --file')

    print(f"Scraping {len(urls)} URL(s)...")

    results = []
    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] Scraping: {url}")
        result = scrape_page(url, timeout=args.timeout)
        results.append(result)

        if result['status'] == 'success':
            print(f"  Found {result['video_count']} video(s)")
            for video_url in result['video_urls'][:3]:  # Show first 3
                print(f"    - {video_url}")
            if result['video_count'] > 3:
                print(f"    ... and {result['video_count'] - 3} more")
        else:
            print(f"  Error: {result['status']}")

    # Save results
    save_results(results, args.output, args.format)
    print(f"\nResults saved to: {args.output}")

    # Summary
    total_videos = sum(r['video_count'] for r in results if r['status'] == 'success')
    successful = sum(1 for r in results if r['status'] == 'success')
    print(f"Summary: {successful}/{len(urls)} pages successful, {total_videos} total videos found")


if __name__ == '__main__':
    main()
