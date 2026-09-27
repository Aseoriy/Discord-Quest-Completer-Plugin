/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

export interface ActivityBackendResponse {
    ok: boolean;
    status: number;
    body: string;
}

interface BaseRequest {
    appId: string;
    questId: string;
    referrer: string;
}

interface AuthorizeRequest extends BaseRequest {
    authCode: string;
}

interface ProgressRequest extends BaseRequest {
    target: number;
    token: string;
}

const NUMERIC_ID = /^\d+$/;
const MAX_ID_LENGTH = 32;
const MAX_SECRET_LENGTH = 16_384;
const MAX_RESPONSE_LENGTH = 65_536;

function validBaseRequest(request: BaseRequest): boolean {
    if (!request || typeof request !== "object") return false;
    if (
        typeof request.appId !== "string"
        || typeof request.questId !== "string"
        || typeof request.referrer !== "string"
        || request.appId.length > MAX_ID_LENGTH
        || request.questId.length > MAX_ID_LENGTH
        || request.referrer.length > MAX_SECRET_LENGTH
        || !NUMERIC_ID.test(request.appId)
        || !NUMERIC_ID.test(request.questId)
    ) return false;

    try {
        const url = new URL(request.referrer);
        return url.protocol === "https:"
            && url.hostname === `${request.appId}.discordsays.com`
            && url.port === ""
            && url.username === ""
            && url.password === "";
    } catch {
        return false;
    }
}

function validSecret(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_SECRET_LENGTH;
}

function rejected(): ActivityBackendResponse {
    return { ok: false, status: 0, body: JSON.stringify({ error: "invalid request parameters" }) };
}

async function postActivityBackend(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>
): Promise<ActivityBackendResponse> {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(15_000)
        });
        const responseBody = (await response.text()).slice(0, MAX_RESPONSE_LENGTH);
        return { ok: response.ok, status: response.status, body: responseBody };
    } catch (error) {
        const message = error instanceof Error ? error.message : "activity backend request failed";
        return { ok: false, status: 0, body: JSON.stringify({ error: message }) };
    }
}

export async function authorizeActivityAchievement(
    _: IpcMainInvokeEvent,
    request: AuthorizeRequest
): Promise<ActivityBackendResponse> {
    if (!validBaseRequest(request) || !validSecret(request.authCode)) return rejected();

    return postActivityBackend(
        `https://${request.appId}.discordsays.com/.proxy/acf/authorize`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": "",
            "X-Discord-Quest-ID": request.questId,
            Referer: request.referrer
        },
        { code: request.authCode }
    );
}

export async function reportActivityAchievement(
    _: IpcMainInvokeEvent,
    request: ProgressRequest
): Promise<ActivityBackendResponse> {
    if (
        !validBaseRequest(request)
        || !validSecret(request.token)
        || !Number.isSafeInteger(request.target)
        || request.target <= 0
    ) return rejected();

    return postActivityBackend(
        `https://${request.appId}.discordsays.com/.proxy/acf/quest/progress`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": request.token,
            "X-Discord-Quest-ID": request.questId,
            Referer: request.referrer
        },
        { progress: request.target }
    );
}
