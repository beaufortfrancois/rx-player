/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import objectAssign from "object-assign";
import {
  combineLatest,
  of as observableOf,
} from "rxjs";
import {
  filter,
  map,
  mergeMap,
} from "rxjs/operators";
import {
  ISegment,
  ISegmentPrivateInfos,
} from "../../manifest/representation_index/interfaces";
import parseMetaManifest from "../../parsers/manifest/metaplaylist";
import request from "../../utils/request";
import DASHTransport from "../dash";
import SmoothTransport from "../smooth";
import {
  ILoaderObservable,
  ILoaderResponse,
  ImageParserObservable,
  IManifestLoaderArguments,
  IManifestParserArguments,
  IManifestParserObservable,
  IOverlayParserObservable,
  ISegmentLoaderArguments,
  ISegmentParserArguments,
  ITransportOptions,
  ITransportPipelines,
  SegmentParserObservable,
} from "../types";
import patchSegmentWithTimeOffset from "./isobmff_patcher";

type ITransportTypes = "dash"|"smooth";

interface IMetaPlaylist {
  contents: Array<{
    url: string;
    startTime: number;
    endTime: number;
    transport: ITransportTypes;
    textTracks: [{
      url: string;
      language: string;
      mimeType: string;
    }];
  }>;
  attributes: {
    timeShiftBufferDepth: number;
  };
  overlays: Array<{
    start : number;
    end : number;
    version : number;
    timescale : number;
    elements : Array<{
      url : string;
      format : string;
      xAxis : string;
      yAxis : string;
      height : string;
      width : string;
    }>;
  }>;
}

/**
 * Parse playlist string to JSON.
 * Returns an array of contents.
 * @param {string} data
 */
function parseMetaPlaylistData(data: string): IMetaPlaylist {
  let parsedMetaPlaylist;
  try {
    parsedMetaPlaylist = JSON.parse(data);
  } catch (error) {
    throw new Error("Bad MetaPlaylist file. Expected JSON.");
  }
  const { contents, attributes, overlays } = parsedMetaPlaylist;
  if (!Array.isArray(contents)) {
    throw new Error("Bad metaplaylist file.");
  }
  contents.forEach((content) => {
    if (
      content.url == null ||
      content.startTime == null ||
      content.endTime == null ||
      content.transport == null ||
      (attributes && attributes.timeShiftBufferDepth == null)
    ) {
      throw new Error("Bad metaplaylist file.");
    }
    if (content.textTracks) {
      content.textTracks.forEach((textTrack: {
        url: string;
        language: string;
        mimeType: string;
      }) => {
        if (
          textTrack.url == null ||
          textTrack.language == null ||
          textTrack.mimeType == null
        ) {
          throw new Error("Bad metaplaylist file.");
        }
      });
    }
  });

  return { contents, attributes, overlays };
}

/**
 * Get parsers base arguments from segment indexes.
 * Patches segment time and get Manifest, Period,
 * Adaptation and Representation from base content.
 */
function getParserBaseArguments<T>(
  segment: ISegment,
  metaplaylistArguments: ISegmentParserArguments<T>,
  offset?: number
): ISegmentParserArguments<T>;
function getParserBaseArguments(
  segment: ISegment,
  metaplaylistArguments: ISegmentLoaderArguments,
  offset?: number
): ISegmentLoaderArguments;
function getParserBaseArguments<T>(
  segment: ISegment,
  metaplaylistArguments: ISegmentParserArguments<T>|ISegmentLoaderArguments,
  offset?: number
): ISegmentParserArguments<T>|ISegmentLoaderArguments {
  const originalSegment =
    offset ?
      objectAssign(
        {},
        segment,
        { time: segment.isInit ? segment.time : segment.time - offset }
      ) :
      segment;

  if (segment.privateInfos && segment.privateInfos.baseContentInfos) {
    const contentInfos = segment.privateInfos.baseContentInfos;
    return objectAssign({}, metaplaylistArguments, {
      manifest: contentInfos.manifest,
      period: contentInfos.period || metaplaylistArguments.period,
      adaptation: contentInfos.adaptation || metaplaylistArguments.adaptation,
      representation: contentInfos.representation || metaplaylistArguments.representation,
      segment: originalSegment,
    });
  } else {
    return objectAssign({}, metaplaylistArguments, { segment: originalSegment });
  }
}

/**
 * Get transport type from segment's privateInfos
 * @param {Object} privateInfos
 */
function getTransportTypeFromSegmentPrivateInfos(
  privateInfos: ISegmentPrivateInfos
): ITransportTypes {
  const transportType = privateInfos.transportType;

  if (!transportType) {
    throw new Error("Undefined transport for content for metaplaylist.");
  }

  return transportType;
}

export default function(options? : ITransportOptions): ITransportPipelines {

    const transports = {
      dash: DASHTransport(options),
      smooth: SmoothTransport(options),
    };

    const manifestPipeline = {
      loader(
        { url } : IManifestLoaderArguments
      ) : ILoaderObservable<Document|string> {
        return request({
          url,
          responseType: "text",
          ignoreProgressEvents: true,
        });
      },

      parser(
        { response, url } : IManifestParserArguments<Document|string>
      ) : IManifestParserObservable {
        if (typeof response.responseData !== "string") {
          throw new Error("Parser input must be string.");
        }
        const {
          contents,
          attributes,
          overlays,
        } = parseMetaPlaylistData(response.responseData);
        const contents$ = contents.map((content) => {
          const transport = transports[content.transport];
          if (transport == null) {
            throw new Error(
              "Transport" + content.transport + "not supported in MetaPlaylist.");
          }
          const loader = transport.manifest.loader;

          return loader({ url: content.url })
            .pipe(
              filter((res): res is ILoaderResponse<Document> => res.type === "response"),
              mergeMap((res) => {
                const parser = transports[content.transport].manifest.parser;
                const fakeResponse = {
                  responseData: res.value.responseData,
                };

                return parser({ response: fakeResponse, url: content.url })
                  .pipe(
                    map((mpd) => {
                      const type = mpd.manifest.type;
                      if (type !== "static") {
                        throw new Error("Content from metaplaylist is not static.");
                      }
                      return objectAssign(content, { manifest: mpd.manifest });
                    })
                  );
              })
            );
        });

        return combineLatest(contents$)
          .pipe(
            map((combinedContents) => {
              const manifest = parseMetaManifest(
                combinedContents,
                attributes,
                overlays,
                url
              );
              return {
                manifest,
                url,
              };
            })
          );
      },
    };

    const segmentPipeline = {
      loader(args : ISegmentLoaderArguments) :
        ILoaderObservable<Uint8Array|ArrayBuffer|null>
      {
        const {
          segment,
          period,
          init,
        } = args;
        if (!segment.privateInfos) {
          throw new Error("Segments from metaplaylist must have private infos.");
        }
        const transportType =
          getTransportTypeFromSegmentPrivateInfos(segment.privateInfos);
        const transport = transports[transportType];
        const segmentLoader = transport.video.loader;
        const offset = (period.start || 0) *
          (init ? (init.timescale || segment.timescale) :  segment.timescale);
        const parserArgs = getParserBaseArguments(segment, args, offset);
        return segmentLoader(parserArgs);
      },

      parser(args : ISegmentParserArguments<Uint8Array|ArrayBuffer|null>
        ) : SegmentParserObservable {
          const { period, init, segment } = args;
          if (!segment.privateInfos) {
            throw new Error("Segments from metaplaylist must have private infos.");
          }
          const transportType =
            getTransportTypeFromSegmentPrivateInfos(segment.privateInfos);
          const transport = transports[transportType];

          if (!transport) {
            throw new Error("Segments from metaplaylist must have private infos.");
          }
          const segmentParser = transport.video.parser;
          const offset = (period.start || 0) *
            (init ? (init.timescale || segment.timescale) :  segment.timescale);

          const parserArgs = getParserBaseArguments(segment, args, offset);

          return segmentParser(parserArgs)
            .pipe(
              map(({ segmentData, segmentInfos }) => {
                if (segmentData == null) {
                  return ({ segmentData: null, segmentInfos: null });
                }
                const responseData = segmentData instanceof Uint8Array ?
                  segmentData :
                  new Uint8Array(segmentData);

                const segmentPatchedData = patchSegmentWithTimeOffset(
                  responseData,
                  offset
                );
                if (segmentInfos && segmentInfos.time > -1) {
                  segmentInfos.time += offset;
                }
                return { segmentData: segmentPatchedData, segmentInfos };
              })
            );
        },
      };

    const textTrackPipeline = {
      loader: (args: ISegmentLoaderArguments) => {
        if (!args.segment.privateInfos) {
          throw new Error("Segments from metaplaylist must have private infos.");
        }
        const transportType =
          getTransportTypeFromSegmentPrivateInfos(args.segment.privateInfos);
        const transport = transports[transportType];
        const offset = args.period.start;
        const parserArgs = getParserBaseArguments(args.segment, args, offset);
        return transport.text.loader(parserArgs);
      },
      parser: (args: ISegmentParserArguments<ArrayBuffer|string|Uint8Array|null>) => {
        if (!args.segment.privateInfos) {
          throw new Error();
        }
        const transportType =
          getTransportTypeFromSegmentPrivateInfos(args.segment.privateInfos);
        const transport = transports[transportType];
        const offset = args.period.start;
        const parserArgs = getParserBaseArguments(args.segment, args, offset);
        return transport.text.parser(parserArgs)
          .pipe(
            map((parsed) => {
              if (parsed.segmentData != null) {
                parsed.segmentData.timeOffset += offset;
              }
              if (parsed.segmentInfos && parsed.segmentInfos.time > -1) {
                parsed.segmentInfos.time += offset;
              }
              return {
                segmentData: parsed.segmentData,
                segmentInfos: parsed.segmentInfos,
              };
            })
          );
      },
    };

    const imageTrackPipeline = {
      loader(args : ISegmentLoaderArguments) :
        ILoaderObservable<ArrayBuffer|Uint8Array|null> {
        if (!args.segment.privateInfos) {
          throw new Error("Segments from metaplaylist must have private infos.");
        }
        const transportType =
          getTransportTypeFromSegmentPrivateInfos(args.segment.privateInfos);
        const transport = transports[transportType];
        const offset = args.period.start;
        const parserArgs = getParserBaseArguments(args.segment, args, offset);
        return transport.image.loader(parserArgs);
      },
      parser(
        args : ISegmentParserArguments<ArrayBuffer|Uint8Array|null>
      ) : ImageParserObservable {
        if (!args.segment.privateInfos) {
          throw new Error("Segments from metaplaylist must have private infos.");
        }
        const transportType =
          getTransportTypeFromSegmentPrivateInfos(args.segment.privateInfos);
        const transport = transports[transportType];

        const offset = args.period.start;
        const parserArgs = getParserBaseArguments(args.segment, args, offset);
        return transport.image.parser(parserArgs)
          .pipe(
            map((parsed) => {
              if (parsed.segmentData != null) {
                parsed.segmentData.timeOffset += offset;
              }
              if (parsed.segmentInfos && parsed.segmentInfos.time > -1) {
                parsed.segmentInfos.time += offset;
              }
              return parsed;
            })
          );
      },
    };

  const overlayTrackPipeline = {
    loader() : ILoaderObservable<Uint8Array|ArrayBuffer|null> {
      // For now, nothing is downloaded.
      // Everything is parsed from the segment
      return observableOf({
        type: "data" as "data",
        value: { responseData: null },
      });
    },

    parser(
      args : ISegmentParserArguments<ArrayBuffer|Uint8Array|null>
    ) : IOverlayParserObservable {
      const { segment } = args;
      const { privateInfos } = segment;
      if (!privateInfos || privateInfos.overlayInfos == null) {
        throw new Error("An overlay segment should have private infos.");
      }
      const { overlayInfos } = privateInfos;
      const end = segment.duration != null ?
        segment.duration - segment.time : overlayInfos.end;
      return observableOf({
        segmentInfos: {
          time: segment.time,
          duration: segment.duration,
          timescale: segment.timescale,
        },
        segmentData: {
          data: [overlayInfos],
          start: segment.time,
          end,
          type: "metaplaylist",
          timeOffset: 0,
          timescale: segment.timescale,
        },
      });
    },
  };

      return {
        manifest: manifestPipeline,
        audio: segmentPipeline,
        video: segmentPipeline,
        text: textTrackPipeline,
        image: imageTrackPipeline,
        overlay: overlayTrackPipeline,
      };
}