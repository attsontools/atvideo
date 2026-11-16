#!/usr/bin/env python3
import argparse
import json
import sys


def extract_youtube(url, proxy=None, js_runtime=None):
    import yt_dlp

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "zh-Hans", "zh-Hant", "zh", "zh-CN", "zh-TW"],
    }
    if js_runtime:
        options["js_runtimes"] = {"quickjs": {"path": js_runtime}}
    if proxy:
        options["proxy"] = proxy
    with yt_dlp.YoutubeDL(options) as downloader:
        return downloader.sanitize_info(downloader.extract_info(url, download=False))


def runtime_versions():
    from yt_dlp.version import __version__ as yt_dlp_version
    import yt_dlp_ejs

    return {
        "ytDlp": yt_dlp_version,
        "ytDlpEjs": yt_dlp_ejs.version,
    }


def main():
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--youtube")
    operation.add_argument("--runtime-version", action="store_true")
    parser.add_argument("--proxy")
    parser.add_argument("--js-runtime")
    args = parser.parse_args()
    result = runtime_versions() if args.runtime_version else extract_youtube(
        args.youtube,
        args.proxy,
        args.js_runtime,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
