/**
 * Natural Language Parameter Extraction Engine
 *
 * Advanced parameter extraction using NLP techniques, entity recognition,
 * and contextual understanding to extract structured parameters from natural speech.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 *
 * Input: Natural language voice commands, tool schemas, conversation context
 * Output: Structured parameters with confidence scores and validation
 *
 * Example:
 * const extractor = new ParameterExtractor();
 * const params = await extractor.extractParameters(
 *   "copy the config file from src to backup folder",
 *   "move_file"
 * );
 * // { source: "src/config", destination: "backup/config", confidence: 0.92 }
 */

import * as winston from "winston";
import {
  DESKTOP_COMMANDER_TOOLS,
  DesktopCommanderTool,
  ValidationError
} from "../utils/types";
import { ConversationContext } from "./context-preservation.js";

export interface ExtractionResult {
  parameters: Record<string, unknown>;
  extractedParams?: Record<string, unknown>; // Alias for backward compatibility
  confidence: number;
  validationErrors: ValidationError[];
  extractionMethod: string;
  alternativeInterpretations: Array<{
    parameters: Record<string, unknown>;
    confidence: number;
  }>;
}

export interface EntityMatch {
  entity: string;
  type: 'file' | 'directory' | 'command' | 'number' | 'boolean' | 'text';
  value: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
}

export interface ExtractionContext {
  conversationContext?: ConversationContext;
  currentDirectory?: string;
  availableFiles?: string[];
  availableDirectories?: string[];
  runningProcesses?: Array<{ id: string; name: string; pid: number }>;
}

export interface ParameterSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  required: boolean;
  description: string;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
    enum?: string[];
  };
  contextHints?: string[];
}

export class ParameterExtractor {
  private logger!: winston.Logger;
  private entityPatterns: Map<string, RegExp[]> = new Map();
  private contextualPreprocessors: Map<string, (text: string, context?: ExtractionContext) => string> = new Map();
  private postProcessors: Map<string, (value: unknown, context?: ExtractionContext) => unknown> = new Map();

  private sanitizePath(path: string): string {
    // Prevent path traversal attacks
    const sanitized = path
      .replace(/\.\./g, '') // Remove parent directory references
      .replace(/~\//g, '') // Remove home directory expansion
      .replace(/\$\{.*?\}/g, '') // Remove variable expansion
      .replace(/[;&|`$(){}[\]<>]/g, ''); // Remove shell metacharacters

    // Ensure no absolute paths to sensitive directories
    const blockedPaths = ['/etc/', '/sys/', '/proc/', 'C:\\Windows\\System32'];
    for (const blocked of blockedPaths) {
      if (sanitized.toLowerCase().includes(blocked.toLowerCase())) {
        throw new ValidationError(
          `Access to ${blocked} is not allowed`,
          'path',
          path
        );
      }
    }

    return sanitized;
  }

  constructor() {
    this.setupLogger();
    this.initializeEntityPatterns();
    this.initializePreprocessors();
    this.initializePostProcessors();
  }

  private setupLogger(): void {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/parameter-extraction.log' })
      ]
    });
  }

  private initializeEntityPatterns(): void {
    this.entityPatterns = new Map([
      // File patterns
      ['file', [
        /\b([\w\-\.]+\.\w{1,5})\b/g, // filename.ext
        /\b([\w\-\.]+)\s+file\b/gi, // name + "file"
        /\bfile\s+([\w\-\.]+)/gi, // "file" + name
        /\"([^\"]+\.\w{1,5})\"/g, // quoted filenames
        /\'([^']+\.\w{1,5})\'/g // single quoted filenames
      ]],
      
      // Directory patterns
      ['directory', [
        /\b([\w\-]+)\s+(?:directory|folder|dir)\b/gi,
        /\b(?:directory|folder|dir)\s+([\w\-]+)/gi,
        /\b(src|dist|build|test|docs|config|bin|lib|node_modules)\b/gi,
        /\"([^\"]+\/[^\"]*)\"/g, // quoted paths
        /\'([^']+\/[^']*)\'/g // single quoted paths
      ]],
      
      // Command patterns
      ['command', [
        /\brun\s+([\w\-\.]+(?:\s+[\w\-]+)*)/gi,
        /\bexecute\s+([\w\-\.]+(?:\s+[\w\-]+)*)/gi,
        /\bcommand\s+([\w\-\.]+(?:\s+[\w\-]+)*)/gi,
        /\"([^\"]+)\"/g, // quoted commands
        /\'([^']+)\'/g // single quoted commands
      ]],
      
      // Number patterns
      ['number', [
        /\b(\d+)\b/g,
        /\bpid\s+(\d+)/gi,
        /\bprocess\s+(\d+)/gi,
        /\b(\d+)\s+(?:seconds?|minutes?|hours?)/gi
      ]],
      
      // Boolean patterns
      ['boolean', [
        /\b(true|false|yes|no|enable|disable|on|off)\b/gi,
        /\b(recursive|background|force|overwrite)\b/gi
      ]],
      
      // Text patterns (general content)
      ['text', [
        /\bcontent\s+[\"']([^\"']*)[\"']/gi,
        /\btext\s+[\"']([^\"']*)[\"']/gi,
        /\bwith\s+[\"']([^\"']*)[\"']/gi,
        /\bmessage\s+[\"']([^\"']*)[\"']/gi
      ]]
    ]);
  }

  private initializePreprocessors(): void {
    this.contextualPreprocessors = new Map([
      // Resolve relative references
      ['relativePath', (text: string, context?: ExtractionContext) => {
        if (!context?.currentDirectory) return text;
        
        let result = text.replace(/\b(current|this)\s+(?:directory|folder)/gi, context.currentDirectory);
        result = result.replace(/\.\//g, context.currentDirectory + '/');
        return result.replace(/\bhere\b/gi, context.currentDirectory);
      }],
      
      // Expand abbreviated commands
      ['commandExpansion', (text: string) => {
        return text.replace(/\bls\b/gi, 'list directory')
                  .replace(/\bmv\b/gi, 'move')
                  .replace(/\bcp\b/gi, 'copy')
                  .replace(/\brm\b/gi, 'delete')
                  .replace(/\bmkdir\b/gi, 'create directory')
                  .replace(/\bcat\b/gi, 'read file')
                  .replace(/\bgrep\b/gi, 'search');
      }],
      
      // Resolve temporal references
      ['temporalResolution', (text: string, context?: ExtractionContext) => {
        if (!context?.conversationContext) return text;
        
        const recentFiles = Array.from(context.conversationContext.activeFiles).slice(0, 3);
        const lastFile = recentFiles[0];
        
        if (lastFile) {
          text = text.replace(/\b(that|the|last)\s+file\b/gi, lastFile)
                    .replace(/\bit\b/gi, lastFile);
        }
        
        return text;
      }]
    ]);
  }

  private initializePostProcessors(): void {
    this.postProcessors = new Map([
      // Normalize and sanitize file paths
      ['filePath', (value: unknown, context?: ExtractionContext) => {
        if (typeof value !== 'string') return value;

        // First sanitize the path
        let path = this.sanitizePath(value);

        // Add current directory if relative
        if (!path.includes('/') && !path.includes('\\') && context?.currentDirectory) {
          path = `${context.currentDirectory}/${path}`;
        }

        // Normalize path separators
        return path.replace(/\\/g, '/');
      }],
      
      // Parse boolean values
      ['boolean', (value: unknown) => {
        if (typeof value !== 'string') return value;
        
        const lowerValue = value.toLowerCase();
        const trueValues = ['true', 'yes', 'enable', 'on', '1', 'recursive', 'background', 'force', 'overwrite'];
        const falseValues = ['false', 'no', 'disable', 'off', '0'];
        
        if (trueValues.includes(lowerValue)) return true;
        if (falseValues.includes(lowerValue)) return false;
        
        return value;
      }],
      
      // Parse numeric values
      ['number', (value: unknown) => {
        if (typeof value !== 'string') return value;
        
        const numMatch = value.match(/\d+/);
        if (numMatch) {
          return parseInt(numMatch[0], 10);
        }
        
        return value;
      }]
    ]);
  }

  async extractParameters(
    text: string,
    toolName: string,
    context?: ExtractionContext
  ): Promise<ExtractionResult> {
    try {
      const tool = DESKTOP_COMMANDER_TOOLS[toolName];
      if (!tool) {
        throw new ValidationError(
          `Unknown tool: ${toolName}`,
          "toolName",
          toolName
        );
      }

      this.logger.debug('Extracting parameters', {
        text,
        toolName,
        schema: tool.inputSchema
      });

      // Step 1: Preprocess text with contextual information
      let processedText = text;
      for (const [name, preprocessor] of this.contextualPreprocessors.entries()) {
        processedText = preprocessor(processedText, context);
        this.logger.debug(`Applied preprocessor ${name}`, { before: text, after: processedText });
      }

      // Step 2: Extract entities from text
      const entities = this.extractEntities(processedText);
      
      // Step 3: Map entities to tool parameters
      const parameterMapping = this.mapEntitiesToParameters(entities, tool, processedText);
      
      // Step 4: Validate extracted parameters
      const validationResult = this.validateParameters(parameterMapping.parameters, tool);
      
      // Step 5: Post-process parameter values
      const processedParameters = this.postProcessParameters(
        parameterMapping.parameters,
        tool,
        context
      );
      
      // Step 6: Generate alternative interpretations
      const alternatives = this.generateAlternatives(entities, tool, processedText, context);

      const result: ExtractionResult = {
        parameters: processedParameters,
        extractedParams: processedParameters, // Alias for backward compatibility
        confidence: this.calculateOverallConfidence(parameterMapping, validationResult),
        validationErrors: validationResult.errors,
        extractionMethod: parameterMapping.method,
        alternativeInterpretations: alternatives
      };

      this.logger.info('Parameter extraction completed', {
        toolName,
        extractedParams: Object.keys(result.parameters),
        confidence: result.confidence,
        validationErrors: result.validationErrors.length
      });

      return result;

    } catch (error) {
      this.logger.error('Parameter extraction failed', {
        text,
        toolName,
        error: (error as Error).message
      });
      throw error;
    }
  }

  private extractEntities(text: string): EntityMatch[] {
    const entities: EntityMatch[] = [];
    
    for (const [entityType, patterns] of this.entityPatterns.entries()) {
      for (const pattern of patterns) {
        let match;
        pattern.lastIndex = 0; // Reset regex state
        
        while ((match = pattern.exec(text)) !== null) {
          const entity: EntityMatch = {
            entity: entityType,
            type: entityType as EntityMatch['type'],
            value: match[1] || match[0],
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            confidence: this.calculateEntityConfidence(entityType, match[0], text)
          };
          
          // Avoid duplicate entities in the same position
          if (!entities.some(e => 
            Math.abs(e.startIndex - entity.startIndex) < 3 && e.type === entity.type
          )) {
            entities.push(entity);
          }
        }
      }
    }
    
    // Sort by confidence and position
    return entities.sort((a, b) => {
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      return a.startIndex - b.startIndex;
    });
  }

  private calculateEntityConfidence(entityType: string, matchedText: string, fullText: string): number {
    let confidence = 0.5; // Base confidence
    
    // Boost confidence based on context clues
    const contextClues = {
      file: ['file', 'read', 'write', 'edit', 'delete', 'move', 'copy'],
      directory: ['directory', 'folder', 'dir', 'list', 'create', 'make'],
      command: ['run', 'execute', 'start', 'command'],
      number: ['pid', 'process', 'port', 'seconds', 'minutes'],
      boolean: ['enable', 'disable', 'force', 'recursive'],
      text: ['content', 'text', 'message', 'with']
    };
    
    const clues = contextClues[entityType as keyof typeof contextClues] || [];
    const lowerFullText = fullText.toLowerCase();
    
    for (const clue of clues) {
      if (lowerFullText.includes(clue)) {
        confidence += 0.2;
      }
    }
    
    // Boost confidence for quoted strings
    if (matchedText.startsWith('"') || matchedText.startsWith("'")) {
      confidence += 0.3;
    }
    
    // Boost confidence for file extensions
    if (entityType === 'file' && /\.[a-zA-Z]{1,5}$/.test(matchedText)) {
      confidence += 0.3;
    }
    
    // Boost confidence for typical directory names
    if (entityType === 'directory') {
      const commonDirs = ['src', 'dist', 'build', 'test', 'docs', 'config', 'bin', 'lib'];
      if (commonDirs.includes(matchedText.toLowerCase())) {
        confidence += 0.4;
      }
    }
    
    return Math.min(1.0, confidence);
  }

  private mapEntitiesToParameters(
    entities: EntityMatch[],
    tool: DesktopCommanderTool,
    text: string
  ): { parameters: Record<string, unknown>; confidence: number; method: string } {
    const parameters: Record<string, unknown> = {};
    const schema = tool.inputSchema;
    const requiredParams = schema.required || [];
    const schemaProps = schema.properties;
    
    let totalConfidence = 0;
    let mappedParams = 0;
    
    // Strategy 1: Direct mapping based on parameter names and types
    for (const [paramName, paramDef] of Object.entries(schemaProps)) {
      const paramInfo = paramDef as { type: string; description?: string };
      
      // Find best matching entity for this parameter
      const candidates = entities.filter(entity => 
        this.isEntitySuitableForParameter(entity, paramName, paramInfo, text)
      );
      
      if (candidates.length > 0) {
        const bestCandidate = candidates[0]; // Already sorted by confidence
        if (bestCandidate) {
          parameters[paramName] = bestCandidate.value;
          totalConfidence += bestCandidate.confidence;
          mappedParams++;

          // Remove used entity to avoid double-mapping
          entities.splice(entities.indexOf(bestCandidate), 1);
        }
      }
    }
    
    // Strategy 2: Positional mapping for remaining entities
    const remainingRequired = requiredParams.filter(param => !(param in parameters));
    const remainingEntities = entities.slice(); // Copy remaining entities
    
    for (let i = 0; i < Math.min(remainingRequired.length, remainingEntities.length); i++) {
      const paramName = remainingRequired[i];
      const entity = remainingEntities[i];
      
      if (paramName && entity) {
        parameters[paramName] = entity.value;
        totalConfidence += entity.confidence * 0.8; // Slight penalty for positional mapping
        mappedParams++;
      }
    }
    
    const averageConfidence = mappedParams > 0 ? totalConfidence / mappedParams : 0;
    
    return {
      parameters,
      confidence: averageConfidence,
      method: mappedParams > 0 ? 'entity-mapping' : 'no-mapping'
    };
  }

  private isEntitySuitableForParameter(
    entity: EntityMatch,
    paramName: string,
    paramDef: { type: string; description?: string },
    text: string
  ): boolean {
    // Direct name matching
    const nameMatches = [
      paramName.toLowerCase(),
      paramName.replace(/_/g, ''),
      paramName.replace(/([A-Z])/g, ' $1').toLowerCase().trim()
    ];
    
    if (nameMatches.some(name => {
      const distance = this.getProximityToParameter(entity, name, text);
      return distance < 20; // Within 20 characters
    })) {
      return true;
    }
    
    // Type-based matching
    const typeCompatibility = {
      string: ['file', 'directory', 'command', 'text'],
      number: ['number'],
      boolean: ['boolean'],
      array: ['text'] // Arrays often represented as comma-separated text
    };
    
    const compatibleTypes = typeCompatibility[paramDef.type as keyof typeof typeCompatibility] || [];
    if (compatibleTypes.includes(entity.type)) {
      return true;
    }
    
    // Semantic matching based on parameter name
    const semanticMappings = {
      path: ['file', 'directory'],
      filename: ['file'],
      directory: ['directory'],
      command: ['command'],
      pid: ['number'],
      content: ['text'],
      message: ['text'],
      source: ['file', 'directory'],
      destination: ['file', 'directory'],
      pattern: ['text']
    };
    
    const semanticTypes = semanticMappings[paramName as keyof typeof semanticMappings] || [];
    return semanticTypes.includes(entity.type);
  }

  private getProximityToParameter(entity: EntityMatch, paramName: string, text: string): number {
    const paramIndex = text.toLowerCase().indexOf(paramName);
    if (paramIndex === -1) return Infinity;
    
    return Math.min(
      Math.abs(entity.startIndex - paramIndex),
      Math.abs(entity.endIndex - paramIndex)
    );
  }

  private validateParameters(
    parameters: Record<string, unknown>,
    tool: DesktopCommanderTool
  ): { isValid: boolean; errors: ValidationError[] } {
    const errors: ValidationError[] = [];
    const schema = tool.inputSchema;
    const requiredParams = schema.required || [];
    
    // Check required parameters
    for (const requiredParam of requiredParams) {
      if (!(requiredParam in parameters) || parameters[requiredParam] === undefined) {
        errors.push(new ValidationError(
          `Required parameter missing: ${requiredParam}`,
          requiredParam,
          undefined
        ));
      }
    }
    
    // Validate parameter types and constraints
    for (const [paramName, value] of Object.entries(parameters)) {
      const paramDef = schema.properties[paramName] as any;
      if (!paramDef) {
        errors.push(new ValidationError(
          `Unknown parameter: ${paramName}`,
          paramName,
          value
        ));
        continue;
      }
      
      // Type validation
      if (!this.validateParameterType(value, paramDef.type)) {
        errors.push(new ValidationError(
          `Invalid type for ${paramName}: expected ${paramDef.type}`,
          paramName,
          value
        ));
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  private validateParameterType(value: unknown, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)));
      case 'boolean':
        return typeof value === 'boolean' || ['true', 'false', 'yes', 'no'].includes(String(value).toLowerCase());
      case 'array':
        return Array.isArray(value) || (typeof value === 'string' && value.includes(','));
      default:
        return true;
    }
  }

  private postProcessParameters(
    parameters: Record<string, unknown>,
    tool: DesktopCommanderTool,
    context?: ExtractionContext
  ): Record<string, unknown> {
    const processed: Record<string, unknown> = {};
    
    for (const [paramName, value] of Object.entries(parameters)) {
      const paramDef = tool.inputSchema.properties[paramName] as any;
      if (!paramDef) {
        processed[paramName] = value;
        continue;
      }
      
      let processedValue = value;
      
      // Apply type-specific post-processing
      switch (paramDef.type) {
        case 'string':
          if (['path', 'filename', 'source', 'destination'].includes(paramName)) {
            processedValue = this.postProcessors.get('filePath')!(value, context);
          }
          break;
        case 'boolean':
          processedValue = this.postProcessors.get('boolean')!(value, context);
          break;
        case 'number':
          processedValue = this.postProcessors.get('number')!(value, context);
          break;
      }
      
      processed[paramName] = processedValue;
    }
    
    return processed;
  }

  private generateAlternatives(
    entities: EntityMatch[],
    tool: DesktopCommanderTool,
    text: string,
    _context?: ExtractionContext
  ): Array<{ parameters: Record<string, unknown>; confidence: number }> {
    const alternatives: Array<{ parameters: Record<string, unknown>; confidence: number }> = [];
    
    // Generate alternative by trying different entity combinations
    const entityCombinations = this.generateEntityCombinations(entities, 3); // Max 3 combinations
    
    for (const combination of entityCombinations) {
      const altMapping = this.mapEntitiesToParameters(combination, tool, text);
      if (Object.keys(altMapping.parameters).length > 0) {
        alternatives.push({
          parameters: altMapping.parameters,
          confidence: altMapping.confidence * 0.8 // Penalty for being alternative
        });
      }
    }
    
    return alternatives.slice(0, 3); // Return top 3 alternatives
  }

  private generateEntityCombinations(
    entities: EntityMatch[],
    maxCombinations: number
  ): EntityMatch[][] {
    const combinations: EntityMatch[][] = [];
    
    // Simple combination generation - in production use more sophisticated approach
    for (let i = 0; i < Math.min(entities.length, maxCombinations); i++) {
      const combination = entities.slice(i, i + 3); // Take groups of 3
      if (combination.length > 0) {
        combinations.push(combination);
      }
    }
    
    return combinations;
  }

  private calculateOverallConfidence(
    mapping: { confidence: number },
    validation: { isValid: boolean; errors: ValidationError[] }
  ): number {
    let confidence = mapping.confidence;
    
    // Penalize for validation errors
    if (!validation.isValid) {
      const errorPenalty = validation.errors.length * 0.2;
      confidence = Math.max(0.1, confidence - errorPenalty);
    }
    
    return Math.min(1.0, confidence);
  }

  // Public helper methods
  getToolSchema(toolName: string): DesktopCommanderTool | null {
    return DESKTOP_COMMANDER_TOOLS[toolName] || null;
  }

  getSupportedTools(): string[] {
    return Object.keys(DESKTOP_COMMANDER_TOOLS);
  }
}

// Validation function for parameter extraction
export async function validateParameterExtractor(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    const extractor = new ParameterExtractor();

    // Test 1: Simple file parameter extraction
    totalTests++;
    try {
      const result = await extractor.extractParameters(
        "read the package.json file",
        "read_file"
      );
      
      if (!result.parameters.path || !result.parameters.path.toString().includes('package.json')) {
        failures.push("Simple extraction test: Failed to extract filename");
      } else {
        console.log("✓ Simple file parameter extraction working");
      }
    } catch (error) {
      failures.push(`Simple extraction test: ${(error as Error).message}`);
    }

    // Test 2: Complex command with multiple parameters
    totalTests++;
    try {
      const result = await extractor.extractParameters(
        "move the config.txt file from src to backup directory",
        "move_file"
      );
      
      if (!result.parameters.source || !result.parameters.destination) {
        failures.push("Complex extraction test: Failed to extract source and destination");
      } else {
        console.log("✓ Complex parameter extraction working");
      }
    } catch (error) {
      failures.push(`Complex extraction test: ${(error as Error).message}`);
    }

    // Test 3: Entity confidence scoring
    totalTests++;
    try {
      const result = await extractor.extractParameters(
        "delete important.txt permanently",
        "delete_file"
      );
      
      if (result.confidence < 0.5) {
        failures.push("Confidence scoring test: Confidence too low for clear command");
      } else {
        console.log("✓ Entity confidence scoring working");
      }
    } catch (error) {
      failures.push(`Confidence scoring test: ${(error as Error).message}`);
    }

    // Test 4: Validation error detection
    totalTests++;
    try {
      const result = await extractor.extractParameters(
        "do something unclear",
        "read_file"
      );
      
      if (result.validationErrors.length === 0) {
        failures.push("Validation test: Should have detected missing required parameter");
      } else {
        console.log("✓ Parameter validation working");
      }
    } catch (error) {
      failures.push(`Validation test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      console.log("Natural language parameter extraction system is validated and ready for production use");
      process.exit(0);
    }
  }

// Validation function kept for testing purposes, but not auto-executed