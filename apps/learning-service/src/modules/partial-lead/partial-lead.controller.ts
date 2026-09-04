import { Request, Response } from 'express';
import { successResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { partialLeadService } from './partial-lead.service';
import { validateSavePartialLead } from './partial-lead.schema';

export const partialLeadController = {
  async list(req: Request, res: Response) {
    const list = await partialLeadService.getAllPartialLeads();
    return res.status(HTTP_STATUS.OK).json(successResponse(list, 'Partial leads fetched successfully'));
  },

  async getById(req: Request, res: Response) {
    const record = await partialLeadService.getById(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(record, 'Partial lead fetched successfully'));
  },

  async savePartial(req: Request, res: Response) {
    const input = validateSavePartialLead(req.body);
    const record = await partialLeadService.savePartialLead(input);
    return res.status(HTTP_STATUS.OK).json(successResponse(record, 'Partial form data saved successfully'));
  },

  async completePartial(req: Request, res: Response) {
    const input = validateSavePartialLead(req.body);
    const result = await partialLeadService.completePartialLead(input);
    return res.status(HTTP_STATUS.CREATED).json(successResponse(result, 'Form completed and lead registered successfully'));
  },

  async delete(req: Request, res: Response) {
    await partialLeadService.deletePartialLead(req.params.id);
    return res.status(HTTP_STATUS.OK).json(successResponse(null, 'Partial lead deleted successfully'));
  },
};
