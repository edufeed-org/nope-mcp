import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Subject vocabulary resource
 */
export function registerSubjectsVocabularyResource(server: McpServer): void {
  server.registerResource(
    'Subject Vocabulary',
    'amb://vocabularies/subjects',
    {
      description:
        'Controlled vocabularies for educational subjects and disciplines. Includes school subjects (Schulfächersystematik) and higher education subjects (Hochschulfächersystematik).',
      mimeType: 'application/json',
    },
    async () => {
      const vocabulary = {
        name: 'AMB Subject Vocabularies',
        description: 'Controlled vocabularies for educational subjects',
        vocabularies: [
          {
            id: 'https://w3id.org/kim/schulfaecher/',
            name: 'Schulfächersystematik',
            description: 'German school subjects vocabulary',
            language: 'de',
            examples: [
              { id: 'https://w3id.org/kim/schulfaecher/s1017', prefLabel: { de: 'Mathematik' } },
              { id: 'https://w3id.org/kim/schulfaecher/s1001', prefLabel: { de: 'Physik' } },
              { id: 'https://w3id.org/kim/schulfaecher/s1019', prefLabel: { de: 'Deutsch' } },
              { id: 'https://w3id.org/kim/schulfaecher/s1007', prefLabel: { de: 'Biologie' } },
              { id: 'https://w3id.org/kim/schulfaecher/s1006', prefLabel: { de: 'Chemie' } },
            ],
          },
          {
            id: 'https://w3id.org/kim/hochschulfaechersystematik/',
            name: 'Hochschulfächersystematik',
            description: 'German higher education subjects vocabulary',
            language: 'de',
            examples: [
              { id: 'https://w3id.org/kim/hochschulfaechersystematik/n1', prefLabel: { de: 'Informatik' } },
              { id: 'https://w3id.org/kim/hochschulfaechersystematik/n2', prefLabel: { de: 'Mathematik' } },
            ],
          },
        ],
        usage: {
          field: 'about',
          filterPath: 'about.prefLabel.<lang>',
          example: 'about.prefLabel.de:Mathematik',
        },
      };

      return {
        contents: [
          {
            uri: 'amb://vocabularies/subjects',
            mimeType: 'application/json',
            text: JSON.stringify(vocabulary, null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Resource types vocabulary resource
 */
export function registerResourceTypesVocabularyResource(server: McpServer): void {
  server.registerResource(
    'Learning Resource Types',
    'amb://vocabularies/resource-types',
    {
      description:
        'HCRT (Hochschulcampus Ressourcentypen) vocabulary for learning resource types.',
      mimeType: 'application/json',
    },
    async () => {
      const vocabulary = {
        name: 'HCRT Learning Resource Types',
        id: 'https://w3id.org/kim/hcrt/',
        description: 'Controlled vocabulary for types of learning resources',
        types: [
          { id: 'https://w3id.org/kim/hcrt/video', prefLabel: { de: 'Video', en: 'Video' } },
          { id: 'https://w3id.org/kim/hcrt/course', prefLabel: { de: 'Kurs', en: 'Course' } },
          { id: 'https://w3id.org/kim/hcrt/worksheet', prefLabel: { de: 'Arbeitsblatt', en: 'Worksheet' } },
          { id: 'https://w3id.org/kim/hcrt/presentation', prefLabel: { de: 'Präsentation', en: 'Presentation' } },
          { id: 'https://w3id.org/kim/hcrt/text', prefLabel: { de: 'Text', en: 'Text' } },
          { id: 'https://w3id.org/kim/hcrt/image', prefLabel: { de: 'Bild', en: 'Image' } },
          { id: 'https://w3id.org/kim/hcrt/audio', prefLabel: { de: 'Audio', en: 'Audio' } },
          { id: 'https://w3id.org/kim/hcrt/assessment', prefLabel: { de: 'Prüfung', en: 'Assessment' } },
          { id: 'https://w3id.org/kim/hcrt/simulation', prefLabel: { de: 'Simulation', en: 'Simulation' } },
          { id: 'https://w3id.org/kim/hcrt/web_page', prefLabel: { de: 'Webseite', en: 'Web Page' } },
        ],
        usage: {
          field: 'learningResourceType',
          filterPath: 'learningResourceType.prefLabel.<lang>',
          example: 'learningResourceType.prefLabel.de:Video',
        },
      };

      return {
        contents: [
          {
            uri: 'amb://vocabularies/resource-types',
            mimeType: 'application/json',
            text: JSON.stringify(vocabulary, null, 2),
          },
        ],
      };
    }
  );
}

/**
 * Educational levels vocabulary resource
 */
export function registerEducationalLevelsVocabularyResource(server: McpServer): void {
  server.registerResource(
    'Educational Levels',
    'amb://vocabularies/educational-levels',
    {
      description:
        'Controlled vocabulary for educational levels in the German education system.',
      mimeType: 'application/json',
    },
    async () => {
      const vocabulary = {
        name: 'Educational Levels',
        id: 'https://w3id.org/kim/educationalLevel/',
        description: 'Controlled vocabulary for educational levels',
        levels: [
          { id: 'https://w3id.org/kim/educationalLevel/level_A', prefLabel: { de: 'Elementarbereich', en: 'Early Childhood Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_1', prefLabel: { de: 'Primarstufe', en: 'Primary Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_2', prefLabel: { de: 'Sekundarstufe I', en: 'Lower Secondary Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_3', prefLabel: { de: 'Sekundarstufe II', en: 'Upper Secondary Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_4', prefLabel: { de: 'Tertiärbereich', en: 'Tertiary Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_5', prefLabel: { de: 'Hochschule', en: 'Higher Education' } },
          { id: 'https://w3id.org/kim/educationalLevel/level_6', prefLabel: { de: 'Weiterbildung', en: 'Continuing Education' } },
        ],
        usage: {
          field: 'educationalLevel',
          filterPath: 'educationalLevel.prefLabel.<lang>',
          example: 'educationalLevel.prefLabel.de:Hochschule',
        },
      };

      return {
        contents: [
          {
            uri: 'amb://vocabularies/educational-levels',
            mimeType: 'application/json',
            text: JSON.stringify(vocabulary, null, 2),
          },
        ],
      };
    }
  );
}
