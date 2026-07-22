import { context, trace, SpanStatusCode, metrics } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

const endpoint = (process.env.SIGNOZ_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/$/, '');
const resource = new Resource({ 'service.name':'faultline-runner', 'service.version':'0.1.0', 'deployment.environment':'demo', 'faultline.project_id':'faultline' });
const provider = new NodeTracerProvider({ resource });
provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })));
provider.register();
const meterProvider = new MeterProvider({ resource });
meterProvider.addMetricReader(new PeriodicExportingMetricReader({ exporter:new OTLPMetricExporter({ url:`${endpoint}/v1/metrics` }), exportIntervalMillis:5000 }));
metrics.setGlobalMeterProvider(meterProvider);
const meter = metrics.getMeter('faultline');
export const telemetry = { runs:meter.createCounter('faultline.runs'), retries:meter.createCounter('faultline.retries'), breaches:meter.createCounter('faultline.budget_breaches'), duration:meter.createHistogram('faultline.agent.duration_ms'), tokens:meter.createCounter('faultline.llm.tokens') };
export const tracer = trace.getTracer('faultline');
export async function flushTelemetry(): Promise<void> { await provider.forceFlush(); }
export async function inSpan<T>(name:string, attrs:Record<string,string|number|boolean>, fn:()=>Promise<T>):Promise<{value:T; traceId:string}> { const span=tracer.startSpan(name,{attributes:attrs}); try { const value=await context.with(trace.setSpan(context.active(),span),fn); return {value,traceId:span.spanContext().traceId}; } catch(e) { span.recordException(e as Error); span.setStatus({code:SpanStatusCode.ERROR,message:e instanceof Error?e.message:String(e)}); throw e; } finally { span.end(); } }
