import {
  createRegistry,
  toBinary,
  type DescFile,
  type DescService,
  type Registry,
} from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { Code, type ConnectRouter } from '@connectrpc/connect';
import * as v1 from '../../gen/grpc/reflection/v1/reflection_pb';
import * as v1alpha from '../../gen/grpc/reflection/v1alpha/reflection_pb';

/** The request fields both protocol versions share. */
interface ReflectionRequest {
  host: string;
  messageRequest:
    | v1.ServerReflectionRequest['messageRequest']
    | v1alpha.ServerReflectionRequest['messageRequest'];
}

type ReflectionAnswer =
  | {
      case: 'fileDescriptorResponse';
      value: { fileDescriptorProto: Uint8Array[] };
    }
  | {
      case: 'allExtensionNumbersResponse';
      value: { baseTypeName: string; extensionNumber: number[] };
    }
  | { case: 'listServicesResponse'; value: { service: { name: string }[] } }
  | {
      case: 'errorResponse';
      value: { errorCode: number; errorMessage: string };
    };

/** The reflection services themselves, as served next to the application's. */
export const REFLECTION_SERVICES: readonly DescService[] = [
  v1.ServerReflection,
  v1alpha.ServerReflection,
];

/**
 * gRPC server reflection (grpc.reflection.v1 and v1alpha, the latter still
 * used by older grpcurl/grpcui builds), answered from the descriptors
 * compiled into the generated code, so what it reports is exactly what the
 * listener serves.
 *
 * Each listener gets its own index over only the services it serves, so the
 * public port never reveals the internal tier's contracts.
 */
export class ReflectionIndex {
  private readonly serviceNames: string[];
  private readonly files = new Map<string, DescFile>();
  private readonly registry: Registry;

  constructor(services: readonly DescService[]) {
    this.serviceNames = [...new Set(services.map((s) => s.typeName))].sort();
    for (const service of services) this.addFile(service.file);
    this.registry = createRegistry(...this.files.values());
  }

  /** Registers ServerReflectionInfo for both protocol versions. */
  register(router: ConnectRouter): void {
    router.service(v1.ServerReflection, {
      serverReflectionInfo: (requests) => this.stream(requests),
    });
    router.service(v1alpha.ServerReflection, {
      serverReflectionInfo: (requests) => this.stream(requests),
    });
  }

  async *stream(requests: AsyncIterable<ReflectionRequest>): AsyncIterable<{
    validHost: string;
    originalRequest: ReturnType<typeof copyRequest>;
    messageResponse: ReflectionAnswer;
  }> {
    for await (const request of requests) {
      yield {
        validHost: request.host,
        originalRequest: copyRequest(request),
        messageResponse: this.answer(request),
      };
    }
  }

  answer(request: ReflectionRequest): ReflectionAnswer {
    const req = request.messageRequest;
    switch (req.case) {
      case 'listServices':
        return {
          case: 'listServicesResponse',
          value: { service: this.serviceNames.map((name) => ({ name })) },
        };
      case 'fileByFilename': {
        const file = this.files.get(req.value);
        return file
          ? this.fileResponse(file)
          : notFound(`File not found: ${req.value}`);
      }
      case 'fileContainingSymbol': {
        const file = this.fileOfSymbol(req.value);
        return file
          ? this.fileResponse(file)
          : notFound(`Symbol not found: ${req.value}`);
      }
      case 'fileContainingExtension': {
        const { containingType, extensionNumber } = req.value;
        const message = this.registry.getMessage(containingType);
        const ext = message
          ? this.registry.getExtensionFor(message, extensionNumber)
          : undefined;
        return ext
          ? this.fileResponse(ext.file)
          : notFound(
              `Extension not found: ${containingType}(${extensionNumber})`,
            );
      }
      case 'allExtensionNumbersOfType': {
        const message = this.registry.getMessage(req.value);
        if (!message) return notFound(`Type not found: ${req.value}`);
        const numbers = [...this.files.values()]
          .flatMap((f) => allExtensions(f))
          .filter((e) => e.extendee.typeName === message.typeName)
          .map((e) => e.number);
        return {
          case: 'allExtensionNumbersResponse',
          value: { baseTypeName: message.typeName, extensionNumber: numbers },
        };
      }
      default:
        return {
          case: 'errorResponse',
          value: {
            errorCode: Code.InvalidArgument,
            errorMessage: 'Empty reflection request',
          },
        };
    }
  }

  private addFile(file: DescFile): void {
    const name = fileName(file);
    if (this.files.has(name)) return;
    this.files.set(name, file);
    for (const dep of file.dependencies) this.addFile(dep);
  }

  /**
   * A symbol is `<package>.<Type>` (messages, enums, services, extensions,
   * nested types included) or `<package>.<Service>.<Method>`.
   */
  private fileOfSymbol(symbol: string): DescFile | undefined {
    const desc = this.registry.get(symbol);
    if (desc) return desc.file;
    const dot = symbol.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const service = this.registry.getService(symbol.slice(0, dot));
    const method = symbol.slice(dot + 1);
    return service?.methods.some((m) => m.name === method)
      ? service.file
      : undefined;
  }

  /** The file plus everything it imports, transitively, dependencies first. */
  private fileResponse(file: DescFile): ReflectionAnswer {
    const ordered: DescFile[] = [];
    const seen = new Set<string>();
    const visit = (f: DescFile) => {
      const name = fileName(f);
      if (seen.has(name)) return;
      seen.add(name);
      f.dependencies.forEach(visit);
      ordered.push(f);
    };
    visit(file);
    // The requested file goes first, as grpc-go and grpc-java do.
    ordered.unshift(ordered.pop() as DescFile);
    return {
      case: 'fileDescriptorResponse',
      value: {
        fileDescriptorProto: ordered.map((f) =>
          toBinary(FileDescriptorProtoSchema, f.proto),
        ),
      },
    };
  }
}

function fileName(file: DescFile): string {
  return file.proto.name;
}

function notFound(message: string): ReflectionAnswer {
  return {
    case: 'errorResponse',
    value: { errorCode: Code.NotFound, errorMessage: message },
  };
}

function allExtensions(file: DescFile) {
  const nested = (messages: DescFile['messages']): DescFile['extensions'] =>
    messages.flatMap((m) => [
      ...m.nestedExtensions,
      ...nested(m.nestedMessages),
    ]);
  return [...file.extensions, ...nested(file.messages)];
}

/** Plain copy, so one answer type fits both protocol versions' messages. */
function copyRequest(request: ReflectionRequest) {
  const req = request.messageRequest;
  const messageRequest =
    req.case === 'fileContainingExtension'
      ? {
          case: req.case,
          value: {
            containingType: req.value.containingType,
            extensionNumber: req.value.extensionNumber,
          },
        }
      : req.case === undefined
        ? { case: undefined }
        : { case: req.case, value: req.value };
  return { host: request.host, messageRequest };
}
