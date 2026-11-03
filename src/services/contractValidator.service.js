import Ajv from 'ajv';

// Initialize Ajv with allErrors: true and relaxed strict mode for user-provided schemas
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Format Ajv error objects into readable error strings.
 */
function formatAjvErrors(errors) {
  if (!errors || errors.length === 0) return [];
  return errors.map(err => {
    const path = err.instancePath ? `at "${err.instancePath}" ` : "";
    if (err.keyword === "required") {
      return `Missing required property "${err.params.missingProperty}"`;
    }
    if (err.keyword === "type") {
      return `Field ${path || "value "}must be of type ${err.params.type}`;
    }
    if (err.keyword === "additionalProperties") {
      return `Unexpected property "${err.params.additionalProperty}" not allowed by contract`;
    }
    return `Contract validation error ${path}${err.message}`;
  });
}

/**
 * Validate that a provided object is a syntactically and semantically valid JSON Schema.
 */
function validateSchemaStructure(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      valid: false,
      errors: ["JSON Schema must be a valid non-empty JSON object"]
    };
  }

  try {
    const isStructureValid = ajv.validateSchema(schema);
    if (!isStructureValid) {
      const errMsgs = ajv.errors ? ajv.errors.map(e => `${e.instancePath || "schema"}: ${e.message}`) : ["Invalid JSON Schema structure"];
      return { valid: false, errors: errMsgs };
    }
    // Try compiling the schema to catch any internal keyword references
    ajv.compile(schema);
    return { valid: true, errors: [] };
  } catch (err) {
    return {
      valid: false,
      errors: [`JSON Schema compilation error: ${err.message}`]
    };
  }
}

/**
 * Validate sample data against a JSON Schema.
 */
function validateSampleAgainstSchema(schema, sampleData) {
  const structureCheck = validateSchemaStructure(schema);
  if (!structureCheck.valid) {
    return { valid: false, errors: structureCheck.errors };
  }

  try {
    const validate = ajv.compile(schema);
    const valid = Boolean(validate(sampleData));
    if (!valid) {
      return {
        valid: false,
        errors: formatAjvErrors(validate.errors)
      };
    }
    return { valid: true, errors: [] };
  } catch (err) {
    return {
      valid: false,
      errors: [`Schema validation failed: ${err.message}`]
    };
  }
}

/**
 * Infer a draft JSON Schema from a sample JSON data payload.
 */
function inferSchemaFromSample(sampleData, title = "Inferred Schema") {
  function inferType(val) {
    if (val === null) return { type: "null" };
    if (Array.isArray(val)) {
      if (val.length === 0) {
        return { type: "array", items: {} };
      }
      return { type: "array", items: inferType(val[0]) };
    }
    if (typeof val === "object") {
      const properties = {};
      const required = [];
      for (const key of Object.keys(val)) {
        properties[key] = inferType(val[key]);
        required.push(key);
      }
      return {
        type: "object",
        required,
        properties
      };
    }
    if (typeof val === "number") {
      return Number.isInteger(val) ? { type: "integer" } : { type: "number" };
    }
    if (typeof val === "boolean") return { type: "boolean" };
    if (typeof val === "string") return { type: "string" };
    return { type: "string" };
  }

  const rootSchema = inferType(sampleData);
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title,
    ...rootSchema
  };
}

export {
  validateSchemaStructure,
  validateSampleAgainstSchema,
  inferSchemaFromSample,
  formatAjvErrors
};
