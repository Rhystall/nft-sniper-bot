const fs = require("fs");
require("dotenv").config();
const { OpenSeaStreamClient, Network } = require("@opensea/stream-js");
const { Seaport } = require("@opensea/seaport-js");
const { ethers } = require("ethers");
const WebSocket = require("ws");

const REQUIRED_ENV = ["OPENSEA_API_KEY", "RPC_URL", "PRIVATE_KEY"];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        throw new Error(`${key} belum di-set di file .env`);
    }
}

// ==========================================
// 1. CONFIG AREA
// ==========================================
const TARGET_CONFIG = {
    collectionSlug: process.env.COLLECTION_SLUG || "deathandtaxes-citizen",
    metadataFile: "./data_nft.json",
    maxPriceEth: Number(process.env.MAX_PRICE_ETH || "0.02"),
    targetTraits: {
        type: ["teddy", "pepe", "doom", "peaky", "reaper"],
    },
};

const GAS_BUFFER_BPS = Number(process.env.GAS_BUFFER_BPS || "1500");
const MAX_PRICE_WEI = ethers.parseUnits(TARGET_CONFIG.maxPriceEth.toString(), 18);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const buyerAddress = process.env.BUYER_ADDRESS || signer.address;

const seaportClientCache = new Map();
const inFlightOrderHashes = new Set();
const boughtOrderHashes = new Set();

function getSeaportClient(protocolAddress) {
    const key = protocolAddress ? protocolAddress.toLowerCase() : "default";

    if (!seaportClientCache.has(key)) {
        if (protocolAddress) {
            seaportClientCache.set(
                key,
                new Seaport(signer, { overrides: { contractAddress: protocolAddress } }),
            );
        } else {
            seaportClientCache.set(key, new Seaport(signer));
        }
    }

    return seaportClientCache.get(key);
}

function applyFeeBuffer(value, bps) {
    return (value * (10_000n + BigInt(bps))) / 10_000n;
}

async function getBufferedGasOverrides() {
    const feeData = await provider.getFeeData();
    const overrides = {};

    if (feeData.maxPriorityFeePerGas != null && feeData.maxFeePerGas != null) {
        overrides.maxPriorityFeePerGas = applyFeeBuffer(
            feeData.maxPriorityFeePerGas,
            GAS_BUFFER_BPS,
        );
        overrides.maxFeePerGas = applyFeeBuffer(feeData.maxFeePerGas, GAS_BUFFER_BPS);
        return overrides;
    }

    if (feeData.gasPrice != null) {
        overrides.gasPrice = applyFeeBuffer(feeData.gasPrice, GAS_BUFFER_BPS);
    }

    return overrides;
}

function extractSeaportOrderFromPayload(payload) {
    const orderCandidates = [
        payload?.protocol_data,
        payload?.protocolData,
        payload?.order?.protocol_data,
        payload?.order?.protocolData,
        payload?.listing?.protocol_data,
        payload?.listing?.protocolData,
        payload?.order,
    ];

    let order = null;
    for (const candidate of orderCandidates) {
        if (!candidate || typeof candidate !== "object") {
            continue;
        }

        if (candidate.parameters && candidate.signature) {
            order = candidate;
            break;
        }

        if (candidate.protocol_data?.parameters && candidate.protocol_data?.signature) {
            order = candidate.protocol_data;
            break;
        }

        if (candidate.protocolData?.parameters && candidate.protocolData?.signature) {
            order = candidate.protocolData;
            break;
        }
    }

    const protocolAddressCandidates = [
        payload?.protocol_address,
        payload?.protocolAddress,
        payload?.order?.protocol_address,
        payload?.order?.protocolAddress,
        payload?.listing?.protocol_address,
        payload?.listing?.protocolAddress,
    ];

    const protocolAddress = protocolAddressCandidates.find(
        (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value),
    );

    return { order, protocolAddress };
}

function extractTokenIdFromNftId(nftId) {
    if (typeof nftId !== "string") {
        return null;
    }
    const split = nftId.split("/");
    return split[2] || null;
}

// ==========================================
// 2. LOAD METADATA INTO RAM
// ==========================================
let localNFTData = [];
try {
    localNFTData = JSON.parse(fs.readFileSync(TARGET_CONFIG.metadataFile, "utf8"));
    console.log(`Loaded ${localNFTData.length} items from cache`);
} catch (error) {
    console.error("Gagal load file JSON", error.message);
    process.exit(1);
}

function checkIsTarget(tokenId, priceWei) {
    const listingPriceWei = BigInt(priceWei);
    if (listingPriceWei > MAX_PRICE_WEI) {
        return { isTarget: false, reason: "Kemahalan" };
    }

    const nft = localNFTData.find((item) => item.tokenId === tokenId.toString());
    if (!nft) {
        return { isTarget: false, reason: "Metadata ga ketemu" };
    }

    for (const [traitCategory, desiredValues] of Object.entries(TARGET_CONFIG.targetTraits)) {
        const nftTraitValue = nft.traits?.[traitCategory];
        if (nftTraitValue && desiredValues.includes(nftTraitValue)) {
            return { isTarget: true, reason: `Match! Tipe: ${nftTraitValue}`, nftData: nft };
        }
    }

    return { isTarget: false, reason: "Trait ampas, skip" };
}

async function executeBuyOrderFromEvent(payload, tokenId, priceWei, nftName) {
    const fallbackHash = `${payload?.item?.nft_id || "unknown"}:${payload?.listing_date || "na"}:${priceWei}`;
    const orderHash = payload?.order_hash || fallbackHash;

    if (boughtOrderHashes.has(orderHash)) {
        console.log(`[SKIP] Order ${orderHash} already bought`);
        return;
    }
    if (inFlightOrderHashes.has(orderHash)) {
        console.log(`[SKIP] Order ${orderHash} still in-flight`);
        return;
    }

    inFlightOrderHashes.add(orderHash);

    try {
        const { order, protocolAddress } = extractSeaportOrderFromPayload(payload);
        if (!order) {
            throw new Error(
                "protocol_data order tidak ditemukan di payload stream (payload.protocol_data / payload.order.protocol_data)",
            );
        }

        const seaport = getSeaportClient(protocolAddress);
        const gasOverrides = await getBufferedGasOverrides();

        console.log(
            `[BUY] Execute ${nftName} (#${tokenId}) | orderHash=${orderHash} | protocol=${protocolAddress || "default-v1.6"}`,
        );
        console.log(
            `[BUY] Gas override: ${JSON.stringify({
                maxPriorityFeePerGas: gasOverrides.maxPriorityFeePerGas?.toString(),
                maxFeePerGas: gasOverrides.maxFeePerGas?.toString(),
                gasPrice: gasOverrides.gasPrice?.toString(),
            })}`,
        );

        // IMPORTANT: Fulfill directly from protocol_data extracted from stream event, no REST listing fetch.
        const { executeAllActions } = await seaport.fulfillOrder({
            order,
            accountAddress: buyerAddress,
            recipientAddress: buyerAddress,
            overrides: gasOverrides,
        });

        const tx = await executeAllActions();
        console.log(`[BUY] Tx submitted: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`[BUY] Tx confirmed in block ${receipt.blockNumber}`);
        boughtOrderHashes.add(orderHash);
    } catch (error) {
        console.error(`[BUY] Failed order ${orderHash}:`, error.message);
    } finally {
        inFlightOrderHashes.delete(orderHash);
    }
}

// ==========================================
// 3. OPENSEA STREAM LISTENER
// ==========================================
const client = new OpenSeaStreamClient({
    token: process.env.OPENSEA_API_KEY,
    network: Network.MAINNET,
    connectOptions: {
        transport: WebSocket,
    },
});

console.log(`Listening for new listings on: ${TARGET_CONFIG.collectionSlug}`);
console.log(`Buyer wallet: ${buyerAddress}`);
console.log(`Max buy price: ${TARGET_CONFIG.maxPriceEth} ETH`);
console.log(`Gas buffer: +${(GAS_BUFFER_BPS / 100).toFixed(2)}%`);

client.onItemListed(TARGET_CONFIG.collectionSlug, async (event) => {
    try {
        const payload = event.payload;
        const tokenId = extractTokenIdFromNftId(payload?.item?.nft_id);
        const priceWei = payload?.base_price;

        if (!tokenId || !priceWei) {
            console.log("[SKIP] Payload item listed tidak lengkap");
            return;
        }

        const priceEth = ethers.formatUnits(BigInt(priceWei), 18);
        console.log(`[LISTING] Token #${tokenId} | Price: ${priceEth} ETH`);

        const check = checkIsTarget(tokenId, priceWei);
        if (!check.isTarget) {
            console.log(`[SKIP] ${check.reason}`);
            return;
        }

        console.log(`[MATCH] ${check.reason}`);
        await executeBuyOrderFromEvent(payload, tokenId, priceWei, check.nftData.name);
    } catch (error) {
        console.error("Error parsing listing event:", error.message);
    }
});
