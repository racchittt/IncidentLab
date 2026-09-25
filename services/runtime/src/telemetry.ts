   import { NodeSDK } from "@opentelemetry/sdk-node";
   import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
   import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
   import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
   import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
   import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
   import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

   new NodeSDK({
     traceExporter: new OTLPTraceExporter(),
     metricReader: new PeriodicExportingMetricReader({
       exporter: new OTLPMetricExporter(), exportIntervalMillis: 10000 }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
     instrumentations: [getNodeAutoInstrumentations({
       "@opentelemetry/instrumentation-fs": { enabled: false } })],
   }).start();