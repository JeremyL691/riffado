import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export function isAudioPipelineServiceRequest(request: Request): boolean {
    const expected = env.AUDIO_PIPELINE_TOKEN;
    if (!env.AUDIO_PIPELINE_ENABLED || env.IS_HOSTED || !expected) return false;
    const authorization = request.headers.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    return (
        expectedBytes.length === suppliedBytes.length &&
        timingSafeEqual(expectedBytes, suppliedBytes)
    );
}
