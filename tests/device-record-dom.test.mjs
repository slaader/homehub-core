import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,fire,Element} from './fixtures/mini-dom.mjs';
import {showDeviceRecord,editDeviceRecord} from '../public/device-record.js';
import {leaveView} from '../public/views.js';

test('device details and editing use a shared dialog and the caller’s save operation',async()=>{
 const {document}=installDom();
 const close=Element.prototype.close;
 Element.prototype.showModal=function(){this.open=true;};
 Element.prototype.close=function(){this.open=false;fire(this,'close');};
 try{
  const device={name:'<example>',recognition:'known',revision:4,manualValues:{alias:'Previous'}};
  showDeviceRecord(device);
  const dialog=document.querySelector('.device-record-dialog');
  assert.equal(dialog.open,true);
  assert.match(dialog.textContent,/<example>/);
  assert.doesNotMatch(dialog.textContent,/Edit inventory/);

  const updates=[];
  let reject=true;
  const options={
   async saveRecord(record,values){
    assert.equal(record.revision,4);
    assert.equal(values.alias,'Revised');
    assert.equal(values.recognition,'known');
    if(reject)throw new Error('Record changed elsewhere.');
    return {...record,name:values.alias};
   },
   view:showDeviceRecord,
   onSaved:record=>updates.push(record.name),
  };
  showDeviceRecord(device,{edit:record=>editDeviceRecord(record,options)});
  const edit=dialog.children[0].children.find(node=>node.textContent==='Edit inventory');
  fire(edit,'click');
  const form=dialog.querySelector('.device-edit-form');
  form.children[1].children[1].value='Revised';
  fire(form,'submit');
  await new Promise(setImmediate);
  assert.match(form.textContent,/Record changed elsewhere/);
  assert.deepEqual(updates,[]);
  reject=false;
  fire(form,'submit');
  await new Promise(setImmediate);
  assert.match(dialog.textContent,/Revised/);
  assert.deepEqual(updates,['Revised']);
  leaveView();
  assert.equal(dialog.open,false);
  assert.equal(document.querySelector('.device-record-dialog'),null);
 }finally{
  delete Element.prototype.showModal;
  Element.prototype.close=close;
 }
});
